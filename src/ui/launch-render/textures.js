// launch-render/textures.js — seeded noise, offscreen texture cache, sky, stars, planets, Earth limb, clouds,
// launch sites and landing terrain. Contract: src/ui/launch-render/README.md §5.1.
//
// Everything here is procedural: no image downloads. Heavy work (per-pixel noise, sphere shading, ray-traced
// Earth limb, terrain tiles) happens ONCE per cache key inside cached(); per-frame code only blits cached
// canvases, fills a few gradients and pattern bands. Rules: no unseeded randomness (use rng/hash), Node-safe imports.
//
// Internal building blocks (not part of the contract, may change):
//  - gradient noise gn2p (2D, periodic → seamless tiles) and gn3 (3D → seamless spheres)
//  - planet maps: equirectangular albedo + height (+ ocean/cloud/night for Earth) generated per body id
//  - renderSphere(): per-pixel lit sphere into an ImageData (Lommel-Seeliger for airless bodies, Lambert +
//    limb darkening for gas/cloud worlds, Rayleigh rim, rings, irregular silhouettes)
//  - groundPlane(): perspective ground drawn as horizontal bands filled with transformed patterns (mode-7 style)

// ------------------------------------------------------------------ small math + colour helpers

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const TAU = Math.PI * 2;

function rgbOf(c) {
  if (Array.isArray(c)) return c;
  const s = String(c || '#808080').replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a = 1) => { const [r, g, b] = rgbOf(c); return `rgba(${r | 0},${g | 0},${b | 0},${clamp(a, 0, 1).toFixed(3)})`; };
function mixc(a, b, t) {
  const A = rgbOf(a), B = rgbOf(b);
  return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
}
const cssOf = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
/** Piecewise-linear colour ramp: stops = [[t, '#hex'|[r,g,b]], ...] sorted by t. Writes 0..255 into out. */
function ramp(stops, x, out) {
  if (x <= stops[0][0]) { const c = stops[0][2]; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; }
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], t = (x - a[0]) / (b[0] - a[0] || 1);
      out[0] = a[2][0] + (b[2][0] - a[2][0]) * t; out[1] = a[2][1] + (b[2][1] - a[2][1]) * t; out[2] = a[2][2] + (b[2][2] - a[2][2]) * t;
      return out;
    }
  }
  const c = stops[stops.length - 1][2]; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out;
}
const mkRamp = (pairs) => pairs.map(([t, c]) => [t, c, rgbOf(c)]);

// ------------------------------------------------------------------ PRNG + noise (pure)

/** FNV-1a 32-bit hash of a string. */
export function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h >>> 0;
}

/** mulberry32 PRNG: returns () => [0,1). */
export function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lattice(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * (3 - 2 * t);

/** Smooth value noise in [0,1]. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = lattice(ix, iy, seed), b = lattice(ix + 1, iy, seed);
  const c = lattice(ix, iy + 1, seed), d = lattice(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal Brownian motion of noise2, normalized to [0,1]. */
export function fbm(x, y, { oct = 5, lac = 2, gain = 0.5, seed = 0 } = {}) {
  let amp = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x * f, y * f, seed + i * 131);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return norm ? sum / norm : 0;
}

/** Ridged multifractal in [0,1] (sharp crests: lineae, mountain ridges). */
export function ridged(x, y, { oct = 5, lac = 2, gain = 0.5, seed = 0 } = {}) {
  let amp = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(noise2(x * f, y * f, seed + i * 71) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return norm ? sum / norm : 0;
}

/** Worley F1: distance to the nearest feature point (cell size 1), roughly [0,1]. */
export function worley(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const px = cx + lattice(cx, cy, seed), py = cy + lattice(cx, cy, seed + 17);
      const d = Math.hypot(px - x, py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, best);
}

// --- internal gradient noise (better isotropy than value noise; signed, roughly [-1,1])

function h32(a, b, c, seed) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1440662683) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}
const q5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const G2X = new Float64Array(16), G2Y = new Float64Array(16);
for (let i = 0; i < 16; i++) { G2X[i] = Math.cos((i / 16) * TAU + 0.1); G2Y[i] = Math.sin((i / 16) * TAU + 0.1); }
const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1], [1, 1, 0], [-1, 1, 0], [0, -1, 1], [0, -1, -1]];
const G3X = new Float64Array(G3.map((g) => g[0])), G3Y = new Float64Array(G3.map((g) => g[1])), G3Z = new Float64Array(G3.map((g) => g[2]));

// Permutation table (fixed shuffle) — much faster than per-corner integer hashing.
const PERM = new Uint8Array(512);
{
  const R = rng(0x5eed1234), p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

/** Periodic 2D gradient noise: period px × py lattice cells (x in [0,px) tiles seamlessly). ~[-1,1]. */
function gn2p(x, y, px, py, seed) {
  const fx0 = Math.floor(x), fy0 = Math.floor(y);
  const fx = x - fx0, fy = y - fy0;
  const so = (seed * 2654435761) >>> 0, sx = so & 255, sy = (so >>> 8) & 255;
  const ix0 = ((fx0 % px) + px) % px, iy0 = ((fy0 % py) + py) % py;
  const ix1 = (ix0 + 1) % px, iy1 = (iy0 + 1) % py;
  const X0 = (ix0 + sx) & 255, X1 = (ix1 + sx) & 255, Y0 = (iy0 + sy) & 255, Y1 = (iy1 + sy) & 255;
  const a = PERM[PERM[X0] + Y0] & 15, b = PERM[PERM[X1] + Y0] & 15, c = PERM[PERM[X0] + Y1] & 15, d = PERM[PERM[X1] + Y1] & 15;
  const va = G2X[a] * fx + G2Y[a] * fy, vb = G2X[b] * (fx - 1) + G2Y[b] * fy;
  const vc = G2X[c] * fx + G2Y[c] * (fy - 1), vd = G2X[d] * (fx - 1) + G2Y[d] * (fy - 1);
  const u = q5(fx), v = q5(fy);
  return 1.41 * (va + (vb - va) * u + (vc - va) * v + (va - vb - vc + vd) * u * v);
}
/** Periodic fBm (signed). Base period px × py; each octave doubles frequency and period. */
function pfbm(x, y, px, py, oct, seed, gain = 0.5) {
  let amp = 1, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += amp * gn2p(x * f, y * f, px * f, py * f, seed + i * 7919); n += amp; amp *= gain; f *= 2; }
  return s / n;
}
/** 3D gradient noise ~[-1,1] (improved Perlin, seed = domain offset). */
function gn3(x, y, z, seed) {
  const so = (seed * 2654435761) >>> 0;
  x += (so & 1023) * 0.7317; y += ((so >>> 10) & 1023) * 0.5373; z += ((so >>> 20) & 1023) * 0.4142;
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const xi = X & 255, yi = Y & 255, zi = Z & 255;
  const u = q5(fx), v = q5(fy), w = q5(fz);
  const A = PERM[xi] + yi, AA = PERM[A] + zi, AB = PERM[A + 1] + zi, B = PERM[xi + 1] + yi, BA = PERM[B] + zi, BB = PERM[B + 1] + zi;
  let g;
  g = PERM[AA] & 15; const n000 = G3X[g] * fx + G3Y[g] * fy + G3Z[g] * fz;
  g = PERM[BA] & 15; const n100 = G3X[g] * (fx - 1) + G3Y[g] * fy + G3Z[g] * fz;
  g = PERM[AB] & 15; const n010 = G3X[g] * fx + G3Y[g] * (fy - 1) + G3Z[g] * fz;
  g = PERM[BB] & 15; const n110 = G3X[g] * (fx - 1) + G3Y[g] * (fy - 1) + G3Z[g] * fz;
  g = PERM[AA + 1] & 15; const n001 = G3X[g] * fx + G3Y[g] * fy + G3Z[g] * (fz - 1);
  g = PERM[BA + 1] & 15; const n101 = G3X[g] * (fx - 1) + G3Y[g] * fy + G3Z[g] * (fz - 1);
  g = PERM[AB + 1] & 15; const n011 = G3X[g] * fx + G3Y[g] * (fy - 1) + G3Z[g] * (fz - 1);
  g = PERM[BB + 1] & 15; const n111 = G3X[g] * (fx - 1) + G3Y[g] * (fy - 1) + G3Z[g] * (fz - 1);
  const x00 = n000 + (n100 - n000) * u, x10 = n010 + (n110 - n010) * u, x01 = n001 + (n101 - n001) * u, x11 = n011 + (n111 - n011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}
function fbm3(x, y, z, oct, seed, gain = 0.5) {
  let amp = 1, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += amp * gn3(x * f, y * f, z * f, seed + i * 7919); n += amp; amp *= gain; f *= 2.03; }
  return s / n;
}
function ridge3(x, y, z, oct, seed) {
  let amp = 1, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { const r = 1 - Math.abs(gn3(x * f, y * f, z * f, seed + i * 31)); s += amp * r * r; n += amp; amp *= 0.5; f *= 2.03; }
  return s / n;
}

// ------------------------------------------------------------------ canvases + LRU cache

/** Offscreen canvas (OffscreenCanvas or <canvas>), or null without a DOM (Node). */
export function makeCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
  } catch { /* fall through */ }
  return null;
}

const CACHE = new Map(); // key -> { canvas, bytes }
let cacheBytes = 0;
const CACHE_BUDGET = 48 * 1024 * 1024;

// Generation budget: optional textures (defer: true) are built at most ~BUDGET ms per ~frame window, so a
// scene's first frames never stall for hundreds of ms; they pop in over the next frames instead.
const DEFER = { defer: true };
let BUDGET_MS = 28, lastEnd = -1e9, winSpent = 0;
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
// Deferral only kicks in when we are drawing a live animation (several frames in a row); a one-off draw (tests,
// screenshots, the preview harness) always builds everything so the picture is complete and reproducible.
let liveFrames = 0, lastTick = -1e9;
function tick() {
  const n = nowMs(), d = n - lastTick;
  if (d > 4) { liveFrames = d < 400 ? liveFrames + 1 : 0; lastTick = n; }
}
/** Per-window generation budget for deferrable textures (ms). Infinity/0 = build everything immediately. */
export function setTextureBudget(ms) { BUDGET_MS = ms > 0 && Number.isFinite(ms) ? ms : Infinity; }

/** Cached texture: paint(ctx, w, h) runs once per key. Returns the canvas (or null in Node, or null while a
 *  deferrable texture waits for budget: opts.defer). */
export function cached(key, w, h, paint, opts = null) {
  const hit = CACHE.get(key);
  if (hit) { CACHE.delete(key); CACHE.set(key, hit); return hit.canvas; } // LRU touch
  const t0 = nowMs();
  if (t0 - lastEnd > 6) winSpent = 0; // an idle gap = a new frame
  if (opts && opts.defer && liveFrames >= 3 && winSpent >= BUDGET_MS) return null;
  const c = makeCanvas(w, h);
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  try { paint(ctx, c.width, c.height); } catch (e) { console.error('launch-render texture', key, e); }
  lastEnd = nowMs();
  winSpent += lastEnd - t0;
  if (globalThis.__lrTexLog && lastEnd - t0 > 4) globalThis.__lrTexLog.push([key, Math.round(lastEnd - t0)]); // dev profiling hook
  const bytes = c.width * c.height * 4;
  CACHE.set(key, { canvas: c, bytes });
  cacheBytes += bytes;
  for (const [k, v] of CACHE) {
    if (cacheBytes <= CACHE_BUDGET || k === key) break;
    CACHE.delete(k);
    cacheBytes -= v.bytes;
  }
  return c;
}

const lazy = (key, w, h, paint) => cached(key, w, h, paint, DEFER);

export function clearTextureCache() { CACHE.clear(); cacheBytes = 0; MAPS.clear(); PATTERNS.clear(); }
export function textureStats() { return { count: CACHE.size, bytes: cacheBytes }; }

export function sizeBucket(px) {
  const v = Math.max(1, Number(px) || 1);
  for (const b of [64, 128, 256, 512, 1024]) if (v <= b) return b;
  return 2048;
}

export function lightBucket(light) {
  const a = Math.atan2(num(light?.ay, -0.78), num(light?.ax, -0.62));
  return ((Math.round((a / (Math.PI * 2)) * 16) % 16) + 16) % 16;
}
/** Unit screen light vector of a bucket (so cached art is lit exactly like its key says). */
function bucketLight(lb) { const a = (lb / 16) * TAU; return { ax: Math.cos(a), ay: Math.sin(a) }; }

/** Device scale of the destination context (scene applies setTransform(dpr)); clamp 1..2. */
function devScale(ctx) {
  try { const m = ctx.getTransform?.(); if (m) return clamp(Math.hypot(m.a, m.b) || 1, 1, 2); } catch { /* ignore */ }
  return 1;
}

/** Pattern cache (patterns are bound to their source canvas; WeakMap-like via key). */
const PATTERNS = new Map();
function patternOf(ctx, key, canvas) {
  if (!canvas) return null;
  let p = PATTERNS.get(key);
  if (p && p.src === canvas) return p.pat;
  let pat = null;
  try { pat = ctx.createPattern(canvas, 'repeat'); } catch { pat = null; }
  if (PATTERNS.size > 64) PATTERNS.clear();
  PATTERNS.set(key, { src: canvas, pat });
  return pat;
}
// CanvasPattern.setTransform takes a DOMMatrix2DInit dictionary: one reused plain object avoids allocating a
// DOMMatrix per ground row (hundreds per frame on a landing). Falls back to a DOMMatrix if a browser insists.
const PMAT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
let PMAT_DICT = true;
function setPatternMatrix(pat, a, b, c, d, e, f) {
  if (!pat || typeof pat.setTransform !== 'function') return false;
  PMAT.a = a; PMAT.b = b; PMAT.c = c; PMAT.d = d; PMAT.e = e; PMAT.f = f;
  if (PMAT_DICT) {
    try { pat.setTransform(PMAT); return true; } catch { PMAT_DICT = false; }
  }
  if (typeof DOMMatrix !== 'function') return false;
  pat.setTransform(new DOMMatrix([a, b, c, d, e, f]));
  return true;
}

/** Half-resolution mip chain of a canvas (cached with the source key). */
function mipsOf(key, src, levels = 5) {
  const out = [src];
  if (!src) return out;
  let prev = src;
  for (let i = 1; i < levels; i++) {
    const w = Math.max(4, prev.width >> 1), h = Math.max(4, prev.height >> 1);
    const p = prev;
    const c = lazy(`${key}|mip${i}`, w, h, (g) => { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(p, 0, 0, w, h); });
    if (!c) break;
    out.push(c);
    prev = c;
    if (w <= 8 || h <= 8) break;
  }
  return out;
}

// ------------------------------------------------------------------ lighting

export const SUN = Object.freeze({ ax: -0.62, ay: -0.78 });

/** Sun direction per scene (screen space, towards the sun). */
export function sunFor(mode, world, siteId) {
  if (mode === 'pad') return { ax: -0.95, ay: -0.31 };
  if (world === 'moon' || world === 'mercury') return { ax: -0.85, ay: -0.53 };
  if (world === 'mars') return { ax: -0.8, ay: -0.6 };
  void siteId;
  return { ...SUN };
}
/** 3D unit sun vector in view space (x right, y down, z toward viewer) from a screen light + depth component. */
function sun3(light, z = 0.42) {
  const ax = num(light?.ax, SUN.ax), ay = num(light?.ay, SUN.ay);
  const k = Math.sqrt(Math.max(0, 1 - z * z)) / (Math.hypot(ax, ay) || 1);
  return [ax * k, ay * k, z];
}

// ------------------------------------------------------------------ bodies

/**
 * kind: rendering family. base/palette: albedo ramp (dark → bright). craters: density 0..1.
 * atmosphere: { color, thickness (fraction of radius) } | null. sky: [zenith, horizon] at the surface.
 * dust: plume dust colour. Extra (internal): lon0 (deg, centre longitude shown), shape (irregular bodies),
 * rays (fresh-crater ray strength).
 */
const L = (kind, base, palette, extra = {}) => ({ kind, base, palette, craters: 0.3, atmosphere: null, sky: null, dust: base, lon0: 0, ...extra });

export const BODY_LOOK = {
  generic: L('rocky', '#8a8580', ['#4f4b47', '#7a756f', '#9c968e', '#b5afa6']),
  sun: L('star', '#ffd27a', ['#fff3c4', '#ffb347', '#ff7a1a'], { craters: 0 }),
  mercury: L('rocky', '#8a8178', ['#4e4842', '#6f675f', '#8f867b', '#b0a596', '#cfc5b6'], { craters: 0.95, rays: 0.7, dust: '#9a9084' }),
  venus: L('cloudy', '#e6d3a3', ['#b89458', '#d8bf8a', '#ecdcb4', '#f6ecd2'], { craters: 0, atmosphere: { color: '#f4e4b8', thickness: 0.06 }, sky: ['#b08a4a', '#e8c98a'] }),
  earth: L('earth', '#1f5f9e', ['#0d3a66', '#1f5f9e', '#4b7a3a', '#c9b98a', '#ffffff'], { craters: 0, atmosphere: { color: '#6aa8ff', thickness: 0.03 }, sky: ['#3d7fb8', '#a9c9de'], dust: '#d9d4c6', lon0: -20 }),
  moon: L('rocky', '#8e8b85', ['#3e3d3b', '#5c5a57', '#7e7b76', '#a19d96', '#c4c0b8'], { craters: 0.9, rays: 1, dust: '#a8a49b' }),
  mars: L('rocky', '#a4542e', ['#4a2a1c', '#7a3a20', '#a4542e', '#c27a4c', '#d9a07a'], { craters: 0.35, atmosphere: { color: '#e0a07a', thickness: 0.018 }, sky: ['#6b4a3a', '#c9926a'], dust: '#c98a5a', lon0: -40 }),
  phobos: L('small', '#6b625a', ['#3c3631', '#5a524a', '#766d63', '#958b80'], { craters: 0.8, shape: { a: 1, b: 0.78, amp: 0.1 } }),
  deimos: L('small', '#7a7066', ['#4f4840', '#6d645a', '#8a8075', '#a39889'], { craters: 0.45, shape: { a: 1, b: 0.7, amp: 0.12 } }),
  apophis: L('small', '#6e655c', ['#3f3a34', '#5a534b', '#776e64', '#958b7f'], { craters: 0.2, shape: { a: 1, b: 0.56, amp: 0.07, lobes: 0.22 } }),
  kamooalewa: L('small', '#8a6a55', ['#4e3b2f', '#6d5242', '#8f6e58', '#ad8c74'], { craters: 0.3, shape: { a: 1, b: 0.62, amp: 0.13 } }),
  bennu: L('small', '#4f4a45', ['#211f1d', '#3a3632', '#55504a', '#77706a'], { craters: 0.35, boulders: 1, shape: { a: 1, b: 0.92, amp: 0.05, diamond: 0.12 } }),
  didymos: L('small', '#6a6560', ['#3a3633', '#56514c', '#736d66', '#938c84'], { craters: 0.3, shape: { a: 1, b: 0.9, amp: 0.05, diamond: 0.1 } }),
  psyche: L('small', '#8f8a84', ['#4f4c49', '#6f6b67', '#8f8a84', '#b8b2aa'], { craters: 0.5, shape: { a: 1, b: 0.8, amp: 0.06 } }),
  vesta: L('rocky', '#8a8378', ['#4a4540', '#6a645c', '#8a8378', '#aaa294', '#c4bcaf'], { craters: 0.7, shape: { a: 1, b: 0.86, amp: 0.035 } }),
  ceres: L('rocky', '#6d6a66', ['#3c3a38', '#55524f', '#6d6a66', '#85817c'], { craters: 0.7, lon0: -120 }),
  asteroid_belt: L('small', '#6a645d', ['#3b3733', '#56504a', '#706962', '#8d857c'], { shape: { a: 1, b: 0.66, amp: 0.12 } }),
  trojans: L('small', '#5d4a40', ['#2f2620', '#4a3b33', '#655247', '#7f6a5c'], { shape: { a: 1, b: 0.7, amp: 0.1 } }),
  jupiter: L('gas', '#d8b78a', ['#7a4a2a', '#b88a5a', '#dcc6a2', '#f2e8d6'], { craters: 0, atmosphere: { color: '#f0dcc0', thickness: 0.012 } }),
  io: L('rocky', '#d8c060', ['#3a2a14', '#a07a2a', '#d8c060', '#f0e8a0', '#f6f2d8'], { craters: 0.03, dust: '#d8c070' }),
  europa: L('icy', '#d6cbb4', ['#7a4630', '#a27656', '#c8b494', '#ddd1b8', '#eee6d6'], { craters: 0.12, dust: '#e8e4da', lon0: 180 }),
  ganymede: L('icy', '#8f877c', ['#4a443d', '#6b635a', '#8f877c', '#b4ab9e', '#d4cdc2'], { craters: 0.6, rays: 0.6 }),
  callisto: L('icy', '#5f574e', ['#2e2924', '#463f38', '#5f574e', '#7c7368', '#d8d2c8'], { craters: 1, rays: 0.4 }),
  saturn: L('ring', '#e0c890', ['#a88a5a', '#d4ba84', '#e8d6a8', '#f4ead0'], { craters: 0, atmosphere: { color: '#f2e2b8', thickness: 0.012 } }),
  enceladus: L('icy', '#f2f4f6', ['#b8c4cc', '#d8e0e6', '#eef2f4', '#ffffff'], { craters: 0.3, dust: '#f4f6f8' }),
  titan: L('haze', '#d09a4a', ['#3e2c18', '#8a5a22', '#c48a3e', '#e2aa58'], { craters: 0.05, atmosphere: { color: '#e8b060', thickness: 0.09 }, sky: ['#8a5a22', '#d9a24a'], dust: '#6a4a2a' }),
  uranus: L('gas', '#9fd6dc', ['#7cc0c8', '#9fd6dc', '#bfe6ea', '#d8f2f4'], { craters: 0, atmosphere: { color: '#c8f2f6', thickness: 0.025 } }),
  neptune: L('gas', '#3f68c8', ['#1e3a8a', '#2f56b0', '#4a74d0', '#8aa8e8'], { craters: 0, atmosphere: { color: '#8ab0ff', thickness: 0.025 } }),
  triton: L('icy', '#d8c8c0', ['#8a7068', '#b49e94', '#d8c8c0', '#f0e8e4'], { craters: 0.15 }),
  pluto: L('icy', '#c8a888', ['#4a2a1e', '#8a5a3e', '#c8a888', '#e8d8c4', '#f6f0e8'], { craters: 0.25, lon0: 175, atmosphere: { color: '#a8c8f0', thickness: 0.01 } }),
  charon: L('icy', '#8a8580', ['#4a3a32', '#6a6560', '#8a8580', '#aaa49e'], { craters: 0.45 }),
  kuiper_belt: L('small', '#8a6a5a', ['#4a372d', '#6a5044', '#8a6a5a', '#a88a78'], { shape: { a: 1, b: 0.6, amp: 0.1, lobes: 0.18 } }),
};

export function bodyLook(bodyId) { return BODY_LOOK[bodyId] || BODY_LOOK.generic; }

// ------------------------------------------------------------------ Earth geography (Natural Earth, data/world.json)

const WORLD = { state: 0, polys: null, ver: 0 };
/** Lazily fetch data/world.json (public-domain Natural Earth) for real continent shapes. Browser only. */
function ensureWorld() {
  if (WORLD.state) return;
  WORLD.state = 1;
  try {
    if (typeof fetch !== 'function' || typeof window === 'undefined') { WORLD.state = 3; return; }
    const url = new URL('../../../data/world.json', import.meta.url).href;
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j && Array.isArray(j.countries)) {
        WORLD.polys = [];
        for (const c of j.countries) for (const p of c.polygons || []) WORLD.polys.push(p);
        WORLD.ver++;
        // rebuild the Earth maps in idle slices (≤ ~8 ms each); the old maps stay in use until the new ones are done
        if (MAPS.has('earth')) buildMapsAsync('earth'); else idleRun(() => (MAPS.has('earth') ? true : buildMapsStep('earth', 8)));
      }
      WORLD.state = 2;
    }).catch(() => { WORLD.state = 3; });
  } catch { WORLD.state = 3; }
}

/** Land mask (0..1) on a w×h equirect grid from world polygons; null when unavailable. */
function rasterLand(w, h) {
  if (!WORLD.polys) return null;
  const c = makeCanvas(w, h);
  const g = c && c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  for (const poly of WORLD.polys) {
    g.beginPath();
    for (const ring of poly) {
      ring.forEach(([lo, la], k) => { const x = ((lo + 180) / 360) * w, y = ((90 - la) / 180) * h; if (k) g.lineTo(x, y); else g.moveTo(x, y); });
      g.closePath();
    }
    g.fill('evenodd');
  }
  const d = g.getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] / 255;
  return m;
}

/** Separable box blur (wraps horizontally), radius r texels, 2 passes ≈ gaussian. */
function blurMap(src, w, h, r) {
  let a = src;
  const n = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    const b = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[row + ((k % w) + w) % w];
      for (let x = 0; x < w; x++) {
        b[row + x] = s / n;
        s += a[row + ((x + r + 1) % w)] - a[row + (((x - r) % w) + w) % w];
      }
    }
    const c2 = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += b[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        c2[y * w + x] = s / n;
        s += b[clamp(y + r + 1, 0, h - 1) * w + x] - b[clamp(y - r, 0, h - 1) * w + x];
      }
    }
    a = c2;
  }
  return a;
}

// ------------------------------------------------------------------ planet maps (equirect, generated once)

const MAPS = new Map();
const D2R = Math.PI / 180;

/** Allocates a map + per-texel unit vectors (map space: y north, z = lon 0, x = lon +90°). */
function newMap(w, h) {
  const px = new Float32Array(w * h), py = new Float32Array(w * h), pz = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const lat = (0.5 - (j + 0.5) / h) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < w; i++) {
      const lon = ((i + 0.5) / w - 0.5) * TAU, k = j * w + i;
      px[k] = cl * Math.sin(lon); py[k] = sl; pz[k] = cl * Math.cos(lon);
    }
  }
  return { w, h, px, py, pz, alb: new Float32Array(w * h), hgt: new Float32Array(w * h), col: new Float32Array(w * h * 3), gx: null, gy: null, spec: null, night: null, cloud: null, cw: 0, ch: 0 };
}
const unitOf = (latDeg, lonDeg) => { const la = latDeg * D2R, lo = lonDeg * D2R; return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]; };

/**
 * Stamps one crater (angular radius a, rad) into hgt/alb. fresh 0..1 = bright ejecta + rays.
 * Profile: parabolic bowl, raised rim, ejecta blanket ∝ d^-3, central peak for large craters.
 */
function stampCrater(m, c, a, { depth = 0.9, fresh = 0, rayLen = 6, seed = 1, peak = 0, albDark = 0 } = {}) {
  const { w, h, px, py, pz, hgt, alb } = m;
  const latc = Math.asin(clamp(c[1], -1, 1)), lonc = Math.atan2(c[0], c[2]);
  const ext = a * (fresh > 0.05 ? 1 + rayLen * fresh : 2.6);
  const j0 = clamp(Math.floor((0.5 - (latc + ext) / Math.PI) * h), 0, h - 1), j1 = clamp(Math.ceil((0.5 - (latc - ext) / Math.PI) * h), 0, h - 1);
  const ex = [Math.cos(lonc), 0, -Math.sin(lonc)], no = [-Math.sin(latc) * Math.sin(lonc), Math.cos(latc), -Math.sin(latc) * Math.cos(lonc)];
  const R = rng(seed);
  const nRays = 9 + Math.floor(R() * 12);
  const RT = new Float32Array(256), RL = new Float32Array(256); // per-angle ray strength + length
  for (let k = 0; k < nRays; k++) {
    const ra = R() * TAU, rl = (0.35 + R() * 0.65) * rayLen, rw = 0.05 + R() * 0.1;
    for (let q = 0; q < 256; q++) {
      let da = Math.abs((q / 256) * TAU - ra); if (da > Math.PI) da = TAU - da;
      const v = Math.exp(-(da * da) / (rw * rw * 0.03));
      if (v > RT[q]) { RT[q] = v; RL[q] = rl; }
    }
  }
  const hs = a * depth, extN = ext / a;
  for (let j = j0; j <= j1; j++) {
    const lat = (0.5 - (j + 0.5) / h) * Math.PI;
    const dl = Math.min(Math.PI, ext / Math.max(0.03, Math.cos(lat)));
    const i0 = Math.floor(((lonc - dl) / TAU + 0.5) * w), i1 = Math.min(i0 + w - 1, Math.ceil(((lonc + dl) / TAU + 0.5) * w));
    for (let ii = i0; ii <= i1; ii++) {
      const i = ((ii % w) + w) % w, k = j * w + i;
      const dx = px[k] - c[0], dy = py[k] - c[1], dz = pz[k] - c[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / a;
      if (d > extN) continue;
      let dh;
      if (d < 1) {
        dh = (d * d - 1) * hs + 0.18 * hs;
        if (peak > 0) dh += peak * hs * Math.exp(-(d * d) / 0.02);
      } else dh = 0.18 * hs * Math.pow(d, -3.2);
      dh += 0.12 * hs * Math.exp(-((d - 1) * (d - 1)) / 0.012);
      hgt[k] += dh;
      if (fresh > 0) {
        let bright = d < 1 ? 0.10 * fresh : 0.22 * fresh * Math.exp(-(d - 1) * 2.2);
        if (d > 1.2) {
          let th = Math.atan2(dx * no[0] + dy * no[1] + dz * no[2], dx * ex[0] + dy * ex[1] + dz * ex[2]);
          if (th < 0) th += TAU;
          const q = ((th / TAU) * 256) & 255;
          const ray = RT[q] > 0.01 ? RT[q] * Math.exp(-(d - 1) / RL[q]) : 0;
          bright += 0.26 * fresh * ray;
        }
        alb[k] += bright;
      } else if (albDark && d < 1.05) alb[k] -= albDark;
    }
  }
}

/** Populates a crater field: power-law sizes (many small), a few fresh rayed ones. */
function craterField(m, R, density, { minA = 0.006, maxA = 0.16, rays = 0.6, count = 0, depth = 0.9, skip = null } = {}) {
  const n = count || Math.round(40 + density * 520 * (m.w / 512));
  const texA = (Math.PI / m.h) * 1.1;
  for (let i = 0; i < n; i++) {
    const z = R() * 2 - 1, ph = R() * TAU, s = Math.sqrt(1 - z * z);
    const c = [s * Math.cos(ph), z, s * Math.sin(ph)];
    const a = minA * Math.pow(maxA / minA, Math.pow(R(), 3.2));
    const fresh = R() < 0.06 * rays ? 0.4 + R() * 0.6 : 0;
    const dd = depth * (0.6 + R() * 0.5), rl = 3 + R() * 5, sd = (R() * 4e9) >>> 0;
    if (a < texA || (skip && skip(c, a))) continue;
    stampCrater(m, c, a, { depth: dd, fresh, rayLen: rl, seed: sd, peak: a > 0.05 ? 0.25 : 0 });
  }
}

/** Gradient maps (central differences, per radian, cos-lat corrected). */
function finishMap(m) {
  const { w, h, hgt } = m;
  m.gx = new Float32Array(w * h); m.gy = new Float32Array(w * h);
  const du = TAU / w, dv = Math.PI / h;
  for (let j = 0; j < h; j++) {
    const cl = Math.max(0.08, Math.cos((0.5 - (j + 0.5) / h) * Math.PI));
    const jn = Math.max(0, j - 1), js = Math.min(h - 1, j + 1);
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      m.gx[k] = (hgt[j * w + (i + 1) % w] - hgt[j * w + (i - 1 + w) % w]) / (2 * du * cl);
      m.gy[k] = (hgt[jn * w + i] - hgt[js * w + i]) / ((js - jn) * dv || dv);
    }
  }
  return m;
}

/** Albedo scalar (0..1) → colour via the body palette (even stops). */
function colourize(m, look, tint = null) {
  const st = mkRamp(look.palette.map((c, i) => [i / (look.palette.length - 1), c]));
  const out = [0, 0, 0];
  for (let k = 0; k < m.w * m.h; k++) {
    ramp(st, clamp(m.alb[k], 0, 1), out);
    if (tint) tint(k, out);
    m.col[k * 3] = out[0]; m.col[k * 3 + 1] = out[1]; m.col[k * 3 + 2] = out[2];
  }
}

/** Evaluates a low-frequency field fn(x,y,z) on a coarse equirect grid and bilinearly upsamples it to m. */
function coarseField(m, cw, fn) {
  const ch = cw >> 1, g = new Float32Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    const lat = (0.5 - (j + 0.5) / ch) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < cw; i++) { const lon = ((i + 0.5) / cw - 0.5) * TAU; g[j * cw + i] = fn(cl * Math.sin(lon), sl, cl * Math.cos(lon)); }
  }
  const out = new Float32Array(m.w * m.h), sx = cw / m.w, sy = ch / m.h;
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) out[j * m.w + i] = sample1(g, cw, ch, (i + 0.5) * sx, (j + 0.5) * sy);
  return out;
}

/** Blob mask at a unit vector: list of [lat, lon, radiusDeg, strength]; warped edges. */
function blobAt(x, y, z, blobs, warpSeed, warp = 0.35) {
  const wn = fbm3(x * 3.1, y * 3.1, z * 3.1, 4, warpSeed) * warp;
  let v = 0;
  for (const b of blobs) {
    const c = b._u || (b._u = unitOf(b[0], b[1]));
    const d = Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) / (b[2] * D2R);
    v = Math.max(v, (b[3] ?? 1) * sstep(1.05, 0.55, d + wn));
  }
  return v;
}
const blobField = (m, blobs, warpSeed, warp) => coarseField(m, 128, (x, y, z) => blobAt(x, y, z, blobs, warpSeed, warp));

// Near-side lunar maria (lat, lon, radius deg[, strength]) — recognisable Moon face.
const MARIA = [[33, -16, 17], [28, 17, 10], [8, 30, 11], [17, 59, 7], [-8, 51, 9], [-15, 35, 5], [-21, -17, 9], [5, -55, 15], [25, -50, 14], [-2, -40, 9],
  [-24, -39, 5], [56, -20, 5, 0.8], [57, 5, 5, 0.8], [55, 25, 4, 0.7], [13, 4, 4], [7, -30, 8], [-10, -23, 6], [40, -30, 8], [-1, 87, 4, 0.7], [20, 86, 4, 0.6], [-40, 162, 6, 0.6], [27, 147, 3, 0.6]];
const MARS_DARK = [[9, 70, 12], [-10, 10, 18, 0.8], [-25, -20, 16, 0.75], [-20, 40, 14, 0.7], [-30, 90, 14, 0.6], [45, -30, 12, 0.75], [-55, -40, 18, 0.5], [-20, 140, 18, 0.6], [5, 120, 10, 0.5], [12, -5, 8, 0.6], [-40, 170, 15, 0.5]];

function* genRockyG(id, look) {
  const small = look.kind === 'small';
  const W = small ? 256 : 512, N = W * W / 2, m = newMap(W, W / 2);
  const seed = hash(id), R = rng(seed);
  const icy = look.kind === 'icy';
  let io = null;
  const N1 = coarseField(m, 128, (x, y, z) => fbm3(x * 1.8, y * 1.8, z * 1.8, 5, seed));
  yield;
  for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield;
    const x = m.px[k], y = m.py[k], z = m.pz[k];
    const n1 = N1[k];
    const n2 = fbm3(x * 7, y * 7, z * 7, 3, seed + 9);
    m.alb[k] = 0.58 + n1 * 0.32 + n2 * 0.1;
    m.hgt[k] = (n1 * 0.6 + n2 * 0.25 + gn3(x * 22, y * 22, z * 22, seed + 5) * 0.08) * 0.02;
  }
  let MF = null;
  if (id === 'moon') {
    MF = blobField(m, MARIA, seed + 3, 0.45);
    yield;
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield;
      const mare = MF[k];
      const hi = 0.7 + (m.alb[k] - 0.58) * 0.6;            // bright anorthositic highlands
      const lo = 0.16 + (m.alb[k] - 0.58) * 0.25;          // basalt maria: dark (~0.55x the highland brightness), never black
      m.alb[k] = lerp(hi, lo, mare);
      m.hgt[k] *= 1 - mare * 0.85;
    }
  } else if (id === 'mercury') {
    const CF = blobField(m, [[30, -170, 25, 0.6], [10, 40, 18, 0.35]], seed, 0.35);
    yield;
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield; const c = CF[k]; m.alb[k] -= c * 0.12; m.hgt[k] *= 1 - c * 0.5; }
  } else if (id === 'io') {
    // sulphur plains, darker poles, ~70 volcanic centres: irregular black/red calderas (paterae) inside diffuse
    // plume deposits (white SO2 frost, yellow/orange sulphur rings, red short-chain sulphur around the big ones)
    io = { pat: new Float32Array(N), red: new Float32Array(N), frost: new Float32Array(N) };
    for (let k = 0; k < N; k++) {
      if ((k & 16383) === 16383) yield;
      const x = m.px[k], y = m.py[k], z = m.pz[k];
      m.alb[k] = 0.64 + fbm3(x * 3, y * 3, z * 3, 4, seed) * 0.22 + fbm3(x * 11, y * 11, z * 11, 3, seed + 2) * 0.06 - sstep(0.6, 0.95, Math.abs(y)) * 0.16;
      m.hgt[k] *= 0.3;
      io.frost[k] = sstep(0.15, 0.4, fbm3(x * 2.4 + 7, y * 2.4, z * 2.4, 4, seed + 4)) * (1 - sstep(0.5, 0.8, Math.abs(y)));
    }
    for (let i = 0; i < 70; i++) {
      const zz = R() * 1.7 - 0.85, ph = R() * TAU, s = Math.sqrt(1 - zz * zz), c = [s * Math.cos(ph), zz, s * Math.sin(ph)];
      const a = 0.005 + Math.pow(R(), 3) * 0.022, big = a > 0.014, ring = big ? 7 + R() * 5 : 3 + R() * 2.5, sd = (R() * 1e6) | 0;
      const ex = [c[2], 0, -c[0]]; const el = Math.hypot(ex[0], ex[2]) || 1; ex[0] /= el; ex[2] /= el; // local east
      const elong = 0.6 + R() * 0.8;
      for (let k = 0; k < N; k++) {
        const dx = m.px[k] - c[0], dy = m.py[k] - c[1], dz = m.pz[k] - c[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > a * a * ring * ring) continue;
        const ue = dx * ex[0] + dz * ex[2];
        const vn = Math.sqrt(Math.max(0, d2 - ue * ue));
        const wob = fbm3(m.px[k] * 60, m.py[k] * 60, m.pz[k] * 60, 2, sd) * 0.55;
        const d = Math.sqrt((ue * ue) / (elong * elong) + vn * vn * elong) / a + wob; // irregular, lobed caldera
        if (d < 1) io.pat[k] = Math.max(io.pat[k], sstep(1, 0.7, d));
        const dep = Math.exp(-((d - ring * 0.5) ** 2) / (ring * 1.6)) * (big ? 1 : 0.6) * (0.7 + wob); // diffuse plume deposit
        if (big) io.red[k] = Math.max(io.red[k], dep * 0.85);
        else io.frost[k] = Math.max(io.frost[k], dep * 0.6);
      }
      if ((i & 7) === 7) yield;
    }
  } else if (id === 'europa') {
    // cream/tan water ice; dense reddish-brown lineae at many widths with ragged edges (flat stains, no relief);
    // mottled chaos terrain where the crust broke up and refroze
    const arcs = arcsOf('europa', 260), minW = (TAU / W) * 0.45;
    const CH = coarseField(m, 128, (x, y, z) => fbm3(x * 2.2, y * 2.2, z * 2.2, 4, seed + 7));
    yield;
    for (let k = 0; k < N; k++) {
      if ((k & 16383) === 16383) yield;
      const x = m.px[k], y = m.py[k], z = m.pz[k];
      const rag = fbm3(x * 70, y * 70, z * 70, 2, seed + 3) * 0.004;
      const la = lineaeAt(x + rag, y, z - rag, arcs, minW, hash('europa|cap') + 5);
      const chaos = sstep(0.1, 0.3, CH[k]);
      const mott = fbm3(x * 14, y * 14, z * 14, 3, seed + 8);
      const tan = fbm3(x * 2.5, y * 2.5, z * 2.5, 3, seed + 12);
      m.alb[k] = 0.66 + fbm3(x * 5, y * 5, z * 5, 3, seed) * 0.07 + tan * 0.08 - la.band * 0.42 - chaos * (0.2 + 0.18 * mott);
      m.hgt[k] = -chaos * 0.0015 + mott * chaos * 0.0015;
    }
  } else if (id === 'ganymede') {
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield;
      const x = m.px[k], y = m.py[k], z = m.pz[k];
      const dark = sstep(0.0, 0.12, fbm3(x * 1.5, y * 1.5, z * 1.5, 4, seed + 3));
      const groove = Math.sin((x * 40 + fbm3(x * 3, y * 3, z * 3, 3, seed) * 14)) * 0.5 + 0.5;
      m.alb[k] = lerp(0.62 + groove * 0.1, 0.32, dark) + (m.alb[k] - 0.58) * 0.3;
      m.hgt[k] += (1 - dark) * groove * 0.002;
    }
  } else if (id === 'enceladus') {
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield;
      const x = m.px[k], y = m.py[k], z = m.pz[k];
      const s = sstep(-0.55, -0.75, y);
      const stripes = s * sstep(0.9, 0.99, Math.abs(Math.sin(x * 9 + z * 3 + fbm3(x * 4, y * 4, z * 4, 2, seed) * 2)));
      m.alb[k] = 0.85 + (m.alb[k] - 0.58) * 0.25 - stripes * 0.35;
      m.hgt[k] = m.hgt[k] * (1 - s) + stripes * 0.003;
    }
  } else if (id === 'triton') {
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield;
      const x = m.px[k], y = m.py[k], z = m.pz[k];
      const cap = sstep(0.0, -0.25, y + fbm3(x * 3, y * 3, z * 3, 3, seed) * 0.2);
      const cant = fbm3(x * 14, y * 14, z * 14, 2, seed + 3) * 0.5 + 0.5;
      const streak = cap * sstep(0.6, 0.9, ridge3(x * 6, y * 2, z * 6, 2, seed + 2));
      m.alb[k] = lerp(0.42 + cant * 0.3, 0.85, cap) - streak * 0.3;
    }
  } else if (id === 'pluto') {
    const HF = blobField(m, [[25, 175, 22], [5, 190, 15], [15, 160, 12]], seed, 0.3);
    yield;
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield;
      const x = m.px[k], y = m.py[k], z = m.pz[k];
      const heart = HF[k];
      const belt = sstep(0.25, -0.1, Math.abs(y + 0.12)) * sstep(-0.1, 0.25, fbm3(x * 2, y * 2, z * 2, 4, seed + 1) + 0.15) * (1 - heart);
      m.alb[k] = lerp(0.6 + (m.alb[k] - 0.58) * 0.6, 0.97, heart) - belt * 0.5 + sstep(0.6, 0.9, y) * 0.1;
      m.hgt[k] *= 1 - heart;
    }
  } else if (id === 'charon') {
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield; const y = m.py[k]; m.alb[k] = lerp(m.alb[k], 0.1, sstep(0.75, 0.92, y + fbm3(m.px[k] * 4, y * 4, m.pz[k] * 4, 3, seed) * 0.1) * 0.8); }
  } else if (id === 'callisto') {
    for (let k = 0; k < N; k++) m.alb[k] = 0.42 + (m.alb[k] - 0.58) * 0.5;
    yield;
    stampCrater(m, unitOf(14, 56), 0.09, { depth: 0.25, fresh: 0.7, rayLen: 2, seed: 7 });
  } else if (id === 'vesta') {
    stampCrater(m, unitOf(-75, 300), 0.6, { depth: 0.5, peak: 0.5, seed: 3 });
  }
  const rays = look.rays ?? (icy ? 0.6 : 0.4);
  const mareSkip = MF ? (c, a) => a > 0.009 && blobAt(c[0], c[1], c[2], MARIA, seed + 3, 0.45) > 0.45 : null;
  yield;
  if (look.craters > 0.02) craterField(m, R, id === 'europa' ? 0.03 : look.craters, { rays, maxA: small ? 0.3 : id === 'europa' ? 0.02 : 0.14, minA: small ? 0.02 : 0.006, depth: icy ? 0.5 : 0.9, skip: mareSkip });
  if (id === 'moon') {
    stampCrater(m, unitOf(-43, -11), 0.024, { depth: 1, fresh: 1, rayLen: 18, seed: 11, peak: 0.3 }); // Tycho
    stampCrater(m, unitOf(10, -20), 0.027, { depth: 1, fresh: 0.85, rayLen: 9, seed: 12, peak: 0.3 }); // Copernicus
    stampCrater(m, unitOf(8, -38), 0.009, { depth: 1, fresh: 0.8, rayLen: 8, seed: 13 }); // Kepler
    stampCrater(m, unitOf(24, -47), 0.012, { depth: 1, fresh: 1, rayLen: 4, seed: 14 }); // Aristarchus
    stampCrater(m, unitOf(-58, -14), 0.06, { depth: 0.8, seed: 15, peak: 0.3 }); // Clavius
  }
  if (id === 'ceres') {
    stampCrater(m, unitOf(20, -120), 0.05, { depth: 0.8, seed: 5 });
    const c = unitOf(20, -120);
    for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield; const d = Math.sqrt((m.px[k] - c[0]) ** 2 + (m.py[k] - c[1]) ** 2 + (m.pz[k] - c[2]) ** 2); if (d < 0.014) m.alb[k] = 1.2; }
  }
  if (id === 'europa') stampCrater(m, unitOf(-25, 271), 0.012, { depth: 0.6, fresh: 1, rayLen: 10, seed: 21 });
  let tint = null;
  if (id === 'io') {
    tint = (k, out) => {
      const fr = io.frost[k] * 0.55;
      out[0] = lerp(out[0], 238, fr); out[1] = lerp(out[1], 236, fr); out[2] = lerp(out[2], 214, fr);
      const rd = io.red[k];
      out[0] = lerp(out[0], 196, rd * 0.75); out[1] = lerp(out[1], 92, rd * 0.75); out[2] = lerp(out[2], 40, rd * 0.75);
      const p = io.pat[k];
      if (p > 0) { const hot = fbm3(m.px[k] * 90, m.py[k] * 90, m.pz[k] * 90, 2, 91); out[0] = lerp(out[0], 34 + 70 * sstep(0.2, 0.5, hot), p); out[1] = lerp(out[1], 26 + 20 * sstep(0.2, 0.5, hot), p); out[2] = lerp(out[2], 18, p); }
    };
  } else if (id === 'pluto') tint = (k, out) => { const t = sstep(0.42, 0.2, m.alb[k]) * 0.6; out[0] = lerp(out[0], 92, t); out[1] = lerp(out[1], 38, t); out[2] = lerp(out[2], 22, t); };
  else if (id === 'charon') tint = (k, out) => { if (m.py[k] > 0.7) { const t = sstep(0.4, 0.15, m.alb[k]) * 0.7; out[0] = lerp(out[0], 112, t); out[1] = lerp(out[1], 60, t); out[2] = lerp(out[2], 44, t); } };
  else if (id === 'triton') tint = (k, out) => { const t = sstep(0.6, 0.85, m.alb[k]) * 0.5; out[0] = lerp(out[0], 238, t); out[1] = lerp(out[1], 208, t); out[2] = lerp(out[2], 204, t); };
  yield;
  colourize(m, look, tint);
  yield;
  return finishMap(m);
}

function* genMarsG(id, look) {
  const W = 512, N = W * W / 2, m = newMap(W, W / 2), seed = hash(id), R = rng(seed);
  const tharsis = [[18, -134, 6, 1], [-1, -113, 3.5, 0.6], [12, -104, 3.5, 0.6], [-9, -121, 3.5, 0.6], [20, -103, 3, 0.4]].map((t) => [...t, unitOf(t[0], t[1])]);
  const N1 = coarseField(m, 128, (x, y, z) => fbm3(x * 2, y * 2, z * 2, 5, seed));
  yield;
  const DF = blobField(m, MARS_DARK, seed + 5, 0.55), HL = blobField(m, [[-42, 70, 18], [-50, -43, 10, 0.7]], seed + 9, 0.2);
  yield;
  const DU = coarseField(m, 128, (x, y, z) => fbm3(x * 2.5 + 9, y * 2.5, z * 2.5, 4, seed + 13));
  yield;
  for (let k = 0; k < N; k++) {
    if ((k & 16383) === 16383) yield;
    const x = m.px[k], y = m.py[k], z = m.pz[k];
    const n1 = N1[k], n2 = fbm3(x * 8, y * 8, z * 8, 3, seed + 3);
    const dark = DF[k] * sstep(-0.35, 0.05, n1 + 0.1);
    let a = 0.64 + n1 * 0.2 + n2 * 0.08 - dark * 0.68;
    let hh = (n1 * 0.5 + n2 * 0.3) * 0.02;
    const hel = HL[k]; // Hellas, Argyre
    a += hel * 0.12; hh -= hel * 0.03;
    for (const t of tharsis) {
      const c = t[4], d = Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) / (t[2] * D2R);
      if (d < 2.4) { hh += t[3] * 0.05 * Math.exp(-d * d * 1.2) - (d < 0.18 ? 0.03 * t[3] : 0); a += t[3] * 0.06 * Math.exp(-d * d); }
    }
    m.alb[k] = a; m.hgt[k] = hh;
  }
  // Valles Marineris: one connected trough system ~4000 km long (Noctis Labyrinthus maze in the west, the deep
  // central chasmata, chaos and outflow channels opening east into Chryse), dark floors, sharp walls
  const vmLat = (lo) => -7 - 4 * Math.sin((lo + 100) * 0.06) - (lo > -60 ? (lo + 60) * 0.12 : 0);
  const vmW = (lo) => (lo < -95 ? 1.2 : lo < -55 ? 2 + 2 * Math.sin(((lo + 95) / 40) * Math.PI) : 2.4 + (lo + 55) * 0.12) * D2R;
  for (let j = 0; j < m.h; j++) {
    const lat = (0.5 - (j + 0.5) / m.h) * 180;
    if (lat > 12 || lat < -25) continue;
    for (let i = 0; i < m.w; i++) {
      const lo = ((i + 0.5) / m.w - 0.5) * 360;
      if (lo < -108 || lo > -30) continue;
      const k = j * m.w + i;
      const x = m.px[k], y = m.py[k], z = m.pz[k];
      const wig = fbm3(x * 30, y * 30, z * 30, 3, seed + 40) * 0.6 * D2R;
      let d = Math.abs(lat * D2R - vmLat(lo) * D2R + wig) / vmW(lo);
      if (lo < -95) d = Math.min(d, Math.abs(Math.sin((lo * 0.9 + lat * 1.7) * 0.35 + fbm3(x * 12, y * 12, z * 12, 2, seed + 41) * 2)) * 2.2 + Math.abs(lat * D2R - vmLat(lo) * D2R) / (4 * D2R)); // maze
      if (lo > -45) d = Math.min(d, (Math.abs(lat - (-2 + (lo + 45) * 0.9)) * D2R) / (1.2 * D2R) + 0.35); // outflow to Chryse
      const fade = sstep(-108, -100, lo) * sstep(-30, -38, lo);
      const trough = (1 - sstep(0.75, 1.05, d)) * fade, wall = Math.exp(-((d - 0.95) ** 2) / 0.012) * fade;
      m.hgt[k] -= trough * 0.03;
      m.alb[k] += -trough * 0.2 + wall * 0.05;
    }
  }
  yield;
  yield;
  craterField(m, R, look.craters, { rays: 0, depth: 0.55, maxA: 0.08 });
  yield;
  colourize(m, look, (k, out) => {
    const y = m.py[k], x = m.px[k], z = m.pz[k];
    const capN = sstep(0.925, 0.955, y + fbm3(x * 5, y * 5, z * 5, 3, seed + 11) * 0.03);
    const capS = sstep(0.95, 0.975, -y + fbm3(x * 5, y * 5, z * 5, 3, seed + 12) * 0.03);
    const c = Math.max(capN, capS);
    out[0] = lerp(out[0], 246, c); out[1] = lerp(out[1], 241, c); out[2] = lerp(out[2], 236, c);
    const dust = sstep(0.25, 0.55, DU[k]) * 0.3;
    out[0] = lerp(out[0], 214, dust); out[1] = lerp(out[1], 160, dust); out[2] = lerp(out[2], 112, dust);
  });
  yield;
  return finishMap(m);
}

function genRocky(id, look) { const it = genRockyG(id, look); let r = it.next(); while (!r.done) r = it.next(); return r.value; }
function genMars(id, look) { const it = genMarsG(id, look); let r = it.next(); while (!r.done) r = it.next(); return r.value; }

const JUP_BANDS = [[-90, 0.5], [-60, 0.45], [-45, 0.62], [-37, 0.4], [-30, 0.72], [-23, 0.62], [-19, 0.3], [-10, 0.25], [-7, 0.8], [0, 0.86], [7, 0.78], [9, 0.22], [17, 0.28], [21, 0.78], [27, 0.5], [32, 0.72], [37, 0.42], [45, 0.6], [60, 0.45], [90, 0.42]];
function bandAt(bands, lat) {
  for (let i = 1; i < bands.length; i++) if (lat <= bands[i][0]) { const a = bands[i - 1], b = bands[i]; return lerp(a[1], b[1], sstep(0, 1, (lat - a[0]) / (b[0] - a[0]))); }
  return bands[bands.length - 1][1];
}

function genGas(id, look) {
  const W = 512, N = W * W / 2, m = newMap(W, W / 2), seed = hash(id);
  const jup = id === 'jupiter', sat = look.kind === 'ring', ura = id === 'uranus', nep = id === 'neptune', ven = id === 'venus';
  const grs = unitOf(-22, 20), gds = unitOf(-20, 30);
  const out = [0, 0, 0];
  const st = mkRamp(look.palette.map((c, i) => [i / (look.palette.length - 1), c]));
  for (let k = 0; k < N; k++) {
    const x = m.px[k], y = m.py[k], z = m.pz[k];
    const lat = Math.asin(y) / D2R;
    const turb = fbm3(x * 3, y * 18, z * 3, 5, seed);
    const swirl = fbm3(x * 9 + turb * 2, y * 30, z * 9, 3, seed + 3);
    let v, red = 0;
    if (jup) {
      v = bandAt(JUP_BANDS, lat + turb * 3.5 + swirl * 1.2) + swirl * 0.06;
      v += 0.14 * sstep(0.55, 0.75, fbm3(x * 14, y * 14, z * 14, 2, seed + 9)) * sstep(25, 45, Math.abs(lat));
      const d = Math.sqrt(((x - grs[0]) ** 2 + (z - grs[2]) ** 2) / 0.0144 + ((y - grs[1]) ** 2) / 0.0036);
      red = sstep(1.3, 0.55, d + swirl * 0.3);
    } else if (sat) {
      v = 0.55 + 0.16 * Math.sin(lat * 0.35 + turb * 0.6) + 0.06 * Math.sin(lat * 1.3) + swirl * 0.03;
      if (lat > 74) v = 0.45 + swirl * 0.04;
    } else if (ura) {
      v = 0.5 + 0.05 * Math.sin(lat * 0.2) + turb * 0.03 + sstep(50, 85, lat) * 0.2;
    } else if (nep) {
      v = 0.45 + 0.12 * Math.sin(lat * 0.18 + turb) + swirl * 0.05;
      const d = Math.sqrt(((x - gds[0]) ** 2 + (z - gds[2]) ** 2) / 0.01 + ((y - gds[1]) ** 2) / 0.003);
      v -= 0.35 * sstep(1.2, 0.5, d);
      v += 0.6 * sstep(0.55, 0.8, fbm3(x * 8, y * 40, z * 8, 3, seed + 4)) * sstep(15, 35, Math.abs(lat));
    } else if (ven) {
      const chev = Math.abs(lat) * 0.04 - 0.3 * Math.cos(Math.atan2(x, z) - 0.5);
      v = 0.6 + 0.1 * Math.sin(chev * 4 + turb * 2) + swirl * 0.04 + sstep(60, 80, Math.abs(lat)) * 0.1;
    } else v = 0.5 + turb * 0.2;
    ramp(st, clamp(v, 0, 1), out);
    if (red > 0) { out[0] = lerp(out[0], 190, red); out[1] = lerp(out[1], 104, red); out[2] = lerp(out[2], 66, red); }
    m.col[k * 3] = out[0]; m.col[k * 3 + 1] = out[1]; m.col[k * 3 + 2] = out[2];
  }
  return finishMap(m);
}

function genTitan(id) {
  const W = 256, N = W * W / 2, m = newMap(W, W / 2), seed = hash(id);
  for (let k = 0; k < N; k++) {
    const x = m.px[k], y = m.py[k], z = m.pz[k];
    const n = fbm3(x * 2, y * 2, z * 2, 4, seed);
    const dunes = sstep(0.05, 0.2, n) * sstep(0.55, 0.2, Math.abs(y));
    const hz = sstep(0.4, 0.9, y) * 0.15;
    m.col[k * 3] = 214 - dunes * 26 + hz * 40; m.col[k * 3 + 1] = 150 - dunes * 22 + hz * 20; m.col[k * 3 + 2] = 72 - dunes * 12;
  }
  return finishMap(m);
}

function genSun(id) {
  const W = 256, N = W * W / 2, m = newMap(W, W / 2), seed = hash(id);
  for (let k = 0; k < N; k++) {
    const x = m.px[k], y = m.py[k], z = m.pz[k];
    const g = fbm3(x * 40, y * 40, z * 40, 2, seed) * 0.5 + 0.5;
    const spots = sstep(0.42, 0.55, fbm3(x * 5, y * 5, z * 5, 3, seed + 3)) * sstep(0.6, 0.3, Math.abs(y)) * sstep(0.04, 0.12, Math.abs(y));
    const a = 0.85 + g * 0.15 - spots * 0.75;
    m.col[k * 3] = 255 * Math.min(1, a + 0.1); m.col[k * 3 + 1] = 236 * a + 10; m.col[k * 3 + 2] = 185 * a;
  }
  return finishMap(m);
}

/** Earth maps as a generator: yields every few rows so an idle-time rebuild never blocks a frame for long. */
function* genEarthG() {
  ensureWorld();
  const ver = WORLD.ver;
  const W = 512, H = 256, m = newMap(W, H), seed = 1337;
  let land = rasterLand(W, H);
  yield;
  if (!land) { // fallback continents until world.json arrives
    land = new Float32Array(W * H);
    const LF = coarseField(m, 256, (x, y, z) => fbm3(x * 1.6, y * 1.6, z * 1.6, 5, seed));
    for (let k = 0; k < W * H; k++) land[k] = sstep(0.02, 0.08, LF[k]);
  }
  const near = blurMap(land, W, H, 2);
  yield;
  const wide = blurMap(land, W, H, 7);
  yield;
  m.spec = new Float32Array(W * H);
  m.night = new Float32Array(W * H);
  const NF = coarseField(m, 256, (x, y, z) => fbm3(x * 6, y * 6, z * 6, 4, seed + 1));
  yield;
  const MF = coarseField(m, 256, (x, y, z) => ridge3(x * 5, y * 5, z * 5, 4, seed + 4));
  yield;
  const ocean = mkRamp([[0, '#051a33'], [0.5, '#082a52'], [0.8, '#0f4470'], [0.93, '#1c6a8c'], [1, '#3a8f9e']]);
  const out = [0, 0, 0];
  const FOREST = rgbOf('#26401c'), RAIN = rgbOf('#1c3616'), GRASS = rgbOf('#55663a'), SAV = rgbOf('#8c7e4a'), DESERT = rgbOf('#cfae78'), SAND = rgbOf('#dcc293'), ROCK = rgbOf('#76675a'), TUNDRA = rgbOf('#6d6a58'), BOREAL = rgbOf('#2a3a25'), ICE = rgbOf('#f1f4f8');
  for (let j = 0; j < H; j++) {
    if ((j & 7) === 7) yield;
    const lat = (0.5 - (j + 0.5) / H) * 180, al = Math.abs(lat);
    for (let i = 0; i < W; i++) {
      const k = j * W + i, x = m.px[k], y = m.py[k], z = m.pz[k], lo = ((i + 0.5) / W - 0.5) * 360;
      const L0 = land[k];
      const n = NF[k], n2 = fbm3(x * 20, y * 20, z * 20, 2, seed + 2);
      const shelf = clamp(wide[k] * 1.6 + near[k] * 0.9, 0, 1);
      ramp(ocean, clamp(shelf * 0.95 + n * 0.08, 0, 1), out);
      if (L0 > 0.01) {
        const interior = sstep(0.6, 0.98, wide[k]);
        let arid = Math.exp(-((al - 24) ** 2) / 120) * 0.9 + interior * 0.35 + n * 0.5 - (al < 12 ? 0.5 : 0);
        if (lo > -20 && lo < 60 && lat > 12 && lat < 36) arid += 0.7; // Sahara / Arabia
        if (lo > 115 && lo < 145 && lat < -18 && lat > -33) arid += 0.5; // Australian interior
        if (lo > 55 && lo < 115 && lat > 35 && lat < 48) arid += 0.5; // Central Asian steppe / Gobi
        if (lo > -120 && lo < -100 && lat > 25 && lat < 42) arid += 0.35; // US south-west
        const mtn = sstep(0.55, 0.85, MF[k]) * L0;
        let c;
        if (al < 12 && arid < 0.4) c = mixc(RAIN, FOREST, clamp(n2 + 0.5, 0, 1));
        else if (arid > 0.75) c = mixc(DESERT, SAND, clamp(n2 + 0.5, 0, 1));
        else if (arid > 0.45) c = mixc(SAV, DESERT, sstep(0.45, 0.75, arid));
        else if (al > 55) c = mixc(BOREAL, TUNDRA, sstep(55, 68, al + n * 8));
        else c = mixc(FOREST, GRASS, clamp(arid * 2 + n2, 0, 1));
        c = mixc(c, ROCK, mtn * 0.6);
        const ice = (lat < -62) || (al > 74 + n * 6) || (lat > 60 && lo > -73 && lo < -12);
        if (ice) c = mixc(ICE, [196, 206, 218], clamp(n2 * 0.5 + mtn * 0.4, 0, 1));
        const sh = 0.9 + n2 * 0.25;
        out[0] = lerp(out[0], c[0] * sh, L0); out[1] = lerp(out[1], c[1] * sh, L0); out[2] = lerp(out[2], c[2] * sh, L0);
        m.hgt[k] = (mtn * 0.012 + n * 0.002) * L0;
        if (!ice) m.night[k] = L0 * Math.pow(clamp(fbm3(x * 30, y * 30, z * 30, 2, seed + 8) + 0.25, 0, 1), 3) * (1 - sstep(0.7, 1, arid)) * sstep(68, 50, al) * (0.4 + near[k] * 0.6);
      }
      if (L0 < 0.5 && (lat < -68 + n * 4 || lat > 79 + n * 4)) { out[0] = lerp(out[0], 226, 0.85); out[1] = lerp(out[1], 234, 0.85); out[2] = lerp(out[2], 240, 0.85); }
      m.spec[k] = 1 - sstep(0.1, 0.5, L0);
      m.col[k * 3] = out[0]; m.col[k * 3 + 1] = out[1]; m.col[k * 3 + 2] = out[2];
    }
  }
  // clouds: general circulation bands (ITCZ, dry subtropics, storm tracks) + warped fBm
  const CW = 512, CH = 256;
  m.cloud = new Float32Array(CW * CH); m.cw = CW; m.ch = CH;
  const cm = newMap(CW, CH);
  yield;
  const WX = coarseField(cm, 128, (x, y, z) => fbm3(x * 2.2, y * 2.2, z * 2.2, 3, seed + 20));
  yield;
  const WY = coarseField(cm, 128, (x, y, z) => fbm3(x * 2.2 + 5, y * 2.2, z * 2.2, 3, seed + 21));
  yield;
  for (let j = 0; j < CH; j++) {
    if ((j & 7) === 7) yield;
    const lat = (0.5 - (j + 0.5) / CH) * 180, al = Math.abs(lat);
    const band = 0.18 * Math.exp(-((lat - 6) ** 2) / 40) - 0.2 * Math.exp(-((al - 24) ** 2) / 90) + 0.16 * Math.exp(-((al - 55) ** 2) / 140) - 0.05;
    for (let i = 0; i < CW; i++) {
      const k = j * CW + i, x = cm.px[k], y = cm.py[k], z = cm.pz[k];
      const wx = WX[k], wy = WY[k];
      const c = fbm3(x * 3.2 + wx * 1.4, y * 4.5 + wy * 1.2, z * 3.2 + wx, 5, seed + 22, 0.55);
      const v = c + band;
      m.cloud[k] = sstep(0.02, 0.38, v) * (0.75 + 0.25 * sstep(0.2, 0.5, v));
    }
  }
  yield;
  m.worldVer = ver;
  return finishMap(m);
}
function genEarth() { const it = genEarthG(); let r = it.next(); while (!r.done) r = it.next(); return r.value; }


const MAPGEN = new Map(); // id -> running generator (Earth only; other bodies build in one idle slice)
/** Advances the async build of a body's maps by ~budget ms. Returns true when the maps are current. */
function buildMapsStep(id, budget = 8) {
  const key = BODY_LOOK[id] ? id : 'generic';
  const cur = MAPS.get(key);
  const look = BODY_LOOK[key];
  const incremental = key === 'earth' || key === 'mars' || (look.kind !== 'gas' && look.kind !== 'ring' && look.kind !== 'cloudy' && look.kind !== 'star' && look.kind !== 'haze');
  if (key !== 'earth' && cur) return true;
  if (!incremental) { mapsFor(key); return true; }
  if (key === 'earth' && cur && cur.worldVer === WORLD.ver) return true;
  let it = MAPGEN.get(key);
  if (!it) { it = key === 'earth' ? genEarthG() : key === 'mars' ? genMarsG(key, look) : genRockyG(key, look); MAPGEN.set(key, it); }
  const t0 = nowMs();
  for (;;) {
    const r = it.next();
    if (r.done) { MAPGEN.delete(key); MAPS.set(key, r.value); return true; }
    if (nowMs() - t0 > budget) return false;
  }
}
/** Runs step() in idle callbacks until it returns true. */
function idleRun(step) {
  const ric = typeof requestIdleCallback === 'function' ? (fn) => requestIdleCallback(fn, { timeout: 250 }) : (fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 30);
  const go = () => ric(() => { let done = false; try { done = step(); } catch { done = true; } if (!done) go(); });
  go();
}
function buildMapsAsync(id) { idleRun(() => buildMapsStep(id, 8)); }

/** Planet maps per body id (generated once; Earth regenerates when world.json arrives). */
function mapsFor(id) {
  const key = BODY_LOOK[id] ? id : 'generic';
  const look = BODY_LOOK[key];
  let m = MAPS.get(key);
  if (m) return m;
  const t0 = nowMs();
  if (key === 'earth') m = genEarth();
  else if (key === 'mars') m = genMars(key, look);
  else if (key === 'titan') m = genTitan(key);
  else if (key === 'sun') m = genSun(key);
  else if (look.kind === 'gas' || look.kind === 'ring' || look.kind === 'cloudy') m = genGas(key, look);
  else m = genRocky(key, look);
  MAPS.set(key, m);
  if (globalThis.__lrTexLog) globalThis.__lrTexLog.push(['maps|' + key, Math.round(nowMs() - t0)]);
  return m;
}

// ------------------------------------------------------------------ lit spheres (planet discs)

const SMP = new Float64Array(3);
/** Bilinear sample of a 3-channel map at texel coords (u wraps, v clamps) → SMP. */
function sample3(arr, w, h, u, v) {
  u -= 0.5; v -= 0.5;
  let i0 = Math.floor(u); const j0 = Math.floor(v), fu = u - i0, fv = v - j0;
  i0 = ((i0 % w) + w) % w;
  const i1 = (i0 + 1) % w, ja = clamp(j0, 0, h - 1) * w, jb = clamp(j0 + 1, 0, h - 1) * w;
  const a = (ja + i0) * 3, b = (ja + i1) * 3, c = (jb + i0) * 3, d = (jb + i1) * 3;
  for (let ch = 0; ch < 3; ch++) {
    const t = arr[a + ch] + (arr[b + ch] - arr[a + ch]) * fu, btm = arr[c + ch] + (arr[d + ch] - arr[c + ch]) * fu;
    SMP[ch] = t + (btm - t) * fv;
  }
}
function sample1(arr, w, h, u, v) {
  u -= 0.5; v -= 0.5;
  let i0 = Math.floor(u); const j0 = Math.floor(v), fu = u - i0, fv = v - j0;
  i0 = ((i0 % w) + w) % w;
  const i1 = (i0 + 1) % w, ja = clamp(j0, 0, h - 1) * w, jb = clamp(j0 + 1, 0, h - 1) * w;
  const t = arr[ja + i0] + (arr[ja + i1] - arr[ja + i0]) * fu, b = arr[jb + i0] + (arr[jb + i1] - arr[jb + i0]) * fu;
  return t + (b - t) * fv;
}

/** Sprite half-extent in radii (room for atmosphere halo, rings, corona). */
function padOf(look) {
  if (look.kind === 'ring') return 2.36;
  if (look.kind === 'star') return 1.7;
  if (look.atmosphere) return 1 + Math.max(0.02, look.atmosphere.thickness * 3.2);
  return 1.02;
}

/** Radial silhouette (256 samples, max 1) for irregular small bodies. */
function shapeOf(id, look) {
  const s = look.shape;
  if (!s) return null;
  const out = new Float32Array(256), seed = hash(id + '|shape'), rot = (seed % 628) / 100;
  let mx = 0;
  for (let i = 0; i < 256; i++) {
    const th = (i / 256) * TAU + rot, c = Math.cos(th), sn = Math.sin(th);
    let r = 1 / Math.sqrt((c / (s.a || 1)) ** 2 + (sn / (s.b || 1)) ** 2);
    if (s.diamond) r *= lerp(1, 1.25 / (Math.abs(c) + Math.abs(sn)), s.diamond * 4);
    if (s.lobes) r *= 1 - s.lobes * Math.exp(-(c * c) / 0.09);
    r *= 1 + (s.amp || 0.08) * pfbm(i / 32, 0.5, 8, 4, 3, seed);
    out[i] = r; if (r > mx) mx = r;
  }
  for (let i = 0; i < 256; i++) out[i] /= mx;
  return out;
}

function ringOpacity(rho) {
  if (rho < 1.11 || rho > 2.34) return 0;
  let o;
  if (rho < 1.24) o = 0.03;
  else if (rho < 1.53) o = 0.12 + 0.1 * sstep(1.24, 1.53, rho);
  else if (rho < 1.95) o = 0.62 + 0.3 * sstep(1.53, 1.75, rho);
  else if (rho < 2.03) o = 0.06;
  else if (rho < 2.27) o = (rho > 2.205 && rho < 2.215) ? 0.08 : 0.55 - 0.15 * sstep(2.2, 2.27, rho);
  else if (rho > 2.315 && rho < 2.325) o = 0.35;
  else o = 0;
  return o * (0.82 + 0.18 * Math.sin(rho * 420)) * (0.85 + 0.3 * (noise2(rho * 90, 0.5, 9) - 0.5));
}

/**
 * Renders a lit sphere into an RGBA buffer of S×S. rot = extra spin (rad). The heavy part of the module:
 * runs once per (body, size bucket, light bucket) key.
 */
function renderSphere(buf, S, id, look, lb, rot, withClouds, tiltB = 0.3) {
  const maps = mapsFor(id);
  const pad = padOf(look), R = S / (2 * pad), half = S / 2;
  const L = sun3(bucketLight(lb), 0.42);
  const kind = look.kind;
  const earth = kind === 'earth', gas = kind === 'gas' || kind === 'ring' || kind === 'cloudy', haze = kind === 'haze', star = kind === 'star';
  const airless = !look.atmosphere && !gas && !star;
  const atm = look.atmosphere, AC = atm ? rgbOf(atm.color) : null, thick = atm ? atm.thickness : 0;
  const shape = shapeOf(id, look);
  const lon0 = (look.lon0 || 0) * D2R + rot;
  const { w: MW, h: MH, col, gx, gy } = maps;
  const bump = shapeOf(id, look) ? 8 : airless ? 4.5 : kind === 'rocky' ? 4 : 2;
  const rings = kind === 'ring';
  const psi = rings ? -0.38 : 0, cps = Math.cos(psi), sps = Math.sin(psi);
  const B = 0.44, sB = Math.sin(B), cB = Math.cos(B);
  const Lr = [L[0] * cps + L[1] * sps, -L[0] * sps + L[1] * cps, L[2]];
  const nrY = cB, nrZ = -sB, LdotN = Lr[1] * nrY + Lr[2] * nrZ;
  const Hx = L[0], Hy = L[1], Hz = L[2] + 1, Hn = Math.hypot(Hx, Hy, Hz);
  const aa = 1.2 / R;
  const bt = rings || star ? 0 : tiltB, cbt = Math.cos(bt), sbt = Math.sin(bt);
  for (let j = 0; j < S; j++) {
    const y0 = (j + 0.5 - half) / R;
    for (let i = 0; i < S; i++) {
      const x0 = (i + 0.5 - half) / R;
      const x = x0 * cps + y0 * sps, y = -x0 * sps + y0 * cps;
      const o = (j * S + i) * 4;
      let r = 0, g = 0, b = 0, a = 0;
      const d = Math.sqrt(x * x + y * y);
      let sr = 1;
      if (shape) { let th = Math.atan2(y, x); if (th < 0) th += TAU; sr = shape[Math.floor((th / TAU) * 256) & 255]; }
      const dn = d / sr;
      let zs = -1;
      if (dn < 1 + aa) {
        const xs = x / sr, ys = y / sr, q = Math.min(0.9999, xs * xs + ys * ys);
        zs = Math.sqrt(1 - q);
        const zb = ys * sbt + zs * cbt;
        const lonV = Math.atan2(xs, zb), lat = Math.asin(clamp(-ys * cbt + zs * sbt, -1, 1));
        let lon = lonV + lon0;
        const u = ((lon / TAU + 0.5) % 1 + 1) % 1 * MW, v = (0.5 - lat / Math.PI) * MH;
        sample3(col, MW, MH, u, v);
        let cr = SMP[0], cg = SMP[1], cb = SMP[2];
        // bumped normal
        const bk = bump * (shape ? 1 : sstep(0, 0.4, zs)); // a round body keeps a clean limb: relief fades toward the edge
        let gxx = sample1(gx, MW, MH, u, v) * bk, gyy = sample1(gy, MW, MH, u, v) * bk;
        const gm = Math.hypot(gxx, gyy); if (gm > 0.7) { gxx *= 0.7 / gm; gyy *= 0.7 / gm; }
        const cl = Math.cos(lonV), sl = Math.sin(lonV), cla = Math.cos(lat), sla = Math.sin(lat);
        const ex = cl, ey = -sl * sbt, ez = -sl * cbt;
        const nx0 = -sla * sl, ny0 = -cla * cbt - sla * cl * sbt, nz0 = cla * sbt - sla * cl * cbt;
        let nx = xs - gxx * ex - gyy * nx0, ny = ys - gxx * ey - gyy * ny0, nz = zs - gxx * ez - gyy * nz0;
        const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        const mu0 = nx * L[0] + ny * L[1] + nz * L[2];
        const mus = xs * L[0] + ys * L[1] + zs * L[2];
        const mu = zs;
        let E;
        if (star) {
          E = 1 - 0.62 * (1 - Math.pow(zs, 0.55));
          cr *= E * 1.05; cg *= E * (0.8 + 0.2 * zs); cb *= E * (0.55 + 0.45 * zs);
        } else {
          if (airless) {
            const m0 = Math.max(0, mu0);
            E = (1.25 * m0 / (m0 + mu * 0.85 + 0.04) + 0.35 * m0 + 0.03) * sstep(-0.05, 0.1, mus) + 0.028; // + earthshine: night side reads
          } else if (gas || haze) {
            E = Math.pow(Math.max(0, mu0 + 0.04), 0.8) * sstep(-0.1, 0.12, mus) * (0.42 + 0.58 * Math.pow(mu, 0.4)) * 1.18;
          } else {
            E = Math.pow(Math.max(0, mu0), 0.9) * sstep(-0.06, 0.1, mus) * 1.12;
          }
          cr *= E; cg *= E; cb *= E;
          if (earth && maps.cloud) {
            const cu = u * (maps.cw / MW), cv = v * (maps.ch / MH);
            const cw = withClouds ? sample1(maps.cloud, maps.cw, maps.ch, cu, cv) : 0;
            const sp = sample1(maps.spec, MW, MH, u, v) * (1 - cw);
            const hd = Math.max(0, (nx * Hx + ny * Hy + nz * Hz) / Hn);
            const spec = sp * (Math.pow(hd, 260) * 170 + Math.pow(hd, 40) * 16) * sstep(0, 0.1, mus);
            const cE = Math.max(0, mus) ** 0.8 * sstep(-0.05, 0.1, mus);
            cr = lerp(cr, 250 * cE, cw) + spec; cg = lerp(cg, 252 * cE, cw) + spec * 0.96; cb = lerp(cb, 255 * cE, cw) + spec * 0.88;
            const nl2 = sample1(maps.night, MW, MH, u, v) * sstep(0.02, -0.12, mus) * (1 - cw * 0.8);
            cr += nl2 * 255; cg += nl2 * 190; cb += nl2 * 110;
          }
          if (atm) {
            const lit = sstep(-0.3, 0.35, mus);
            const rim = Math.pow(1 - mu, earth ? 2.4 : haze ? 1.3 : 3.2);
            const k = (earth ? 0.95 : haze ? 0.9 : kind === 'cloudy' ? 0.5 : 0.35) * lit;
            cr += AC[0] * (rim * k + (earth ? 0.06 * lit : 0)); cg += AC[1] * (rim * k + (earth ? 0.06 * lit : 0)); cb += AC[2] * (rim * k + (earth ? 0.08 * lit : 0));
            if (earth) { const veil = 0.12 * lit; cr = lerp(cr, 90 * E, veil); cg = lerp(cg, 140 * E, veil); cb = lerp(cb, 230 * E, veil); }
          }
          if (rings && LdotN !== 0) { // ring shadow on the planet
            const Sx = xs, Sy = ys, Sz = zs, t = -(Sy * nrY + Sz * nrZ) / LdotN;
            if (t > 0) { const qx = Sx + t * Lr[0], qy = Sy + t * Lr[1], qz = Sz + t * Lr[2]; const op = ringOpacity(Math.hypot(qx, qy, qz)); const f = 1 - 0.75 * op; cr *= f; cg *= f; cb *= f; }
          }
        }
        const cov = clamp((1 + aa * 0.5 - dn) / aa, 0, 1);
        r = cr; g = cg; b = cb; a = cov;
      }
      // atmosphere halo / corona outside the limb
      if (a < 1 && (atm || star) && dn > 0.98) {
        const hh = Math.max(0, dn - 1);
        let ga, hr, hg, hb;
        if (star) { ga = Math.exp(-hh * 4.2) * 0.85; hr = 255; hg = 214; hb = 150; }
        else {
          const lit = sstep(-0.45, 0.5, (x / d) * L[0] + (y / d) * L[1]);
          const t = hh / thick;
          ga = Math.exp(-t * (earth ? 2.2 : 2.6)) * lit * (earth ? 1 : 0.8);
          if (haze) ga += 0.35 * Math.exp(-((t - 0.75) ** 2) / 0.02) * lit;
          hr = AC[0]; hg = AC[1]; hb = AC[2];
          if (earth) { const w = sstep(0, 1.2, t); hr = lerp(200, 50, w); hg = lerp(230, 110, w); hb = lerp(255, 240, w); }
          if (haze && t > 0.6) { hr = 150; hg = 170; hb = 230; }
        }
        ga = clamp(ga, 0, 1);
        const aOut = a + ga * (1 - a);
        if (aOut > 0) { r = (r * a + hr * ga * (1 - a)) / aOut; g = (g * a + hg * ga * (1 - a)) / aOut; b = (b * a + hb * ga * (1 - a)) / aOut; }
        a = aOut;
      }
      // rings (in front of the planet where the ring plane is nearer than the surface)
      if (rings) {
        const ry = y / sB, rho = Math.sqrt(x * x + ry * ry), zr = ry * cB;
        const op = ringOpacity(rho);
        if (op > 0 && (a < 0.5 || zr > zs)) {
          let sh = 1;
          const pd = x * Lr[0] + y * Lr[1] + zr * Lr[2];
          if (pd < 0) { const px = x - pd * Lr[0], py = y - pd * Lr[1], pz = zr - pd * Lr[2]; if (px * px + py * py + pz * pz < 1) sh = 0.12; }
          const tone = 0.75 + 0.25 * sstep(1.5, 1.9, rho) - 0.2 * sstep(2.03, 2.3, rho);
          const rr = 214 * tone * sh, rg = 194 * tone * sh, rb = 156 * tone * sh;
          const aOut = op + a * (1 - op);
          r = (rr * op + r * a * (1 - op)) / aOut; g = (rg * op + g * a * (1 - op)) / aOut; b = (rb * op + b * a * (1 - op)) / aOut;
          a = aOut;
        }
      }
      buf[o] = r > 255 ? 255 : r; buf[o + 1] = g > 255 ? 255 : g; buf[o + 2] = b > 255 ? 255 : b; buf[o + 3] = a * 255;
    }
  }
}

function paintSphereSprite(g, S, id, look, lb, rot, clouds, tiltB) {
  const img = g.createImageData(S, S);
  renderSphere(img.data, S, id, look, lb, rot, clouds, tiltB);
  g.putImageData(img, 0, 0);
}

/** Sphere with texture, terminator, limb darkening / atmosphere glow. r = radius (screen px). */
export function drawPlanetDisc(ctx, bodyId, cx, cy, r, { light = SUN, rot = 0, t = 0, clouds = true } = {}) {
  r = num(r); cx = num(cx); cy = num(cy);
  if (!(r > 0.3)) return;
  void t;
  const id = BODY_LOOK[bodyId] ? bodyId : 'generic';
  const look = BODY_LOOK[id];
  if (r < 1.6) { ctx.fillStyle = rgba(look.base, clamp(r, 0.3, 1)); ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.6, r), 0, TAU); ctx.fill(); return; }
  if (id === 'earth') ensureWorld();
  const pad = padOf(look);
  const dpr = devScale(ctx);
  const S = Math.min(512, sizeBucket(2 * r * pad * dpr));
  const lb = lightBucket(light);
  const rq = rot ? Math.round((((num(rot) % TAU) + TAU) % TAU) / TAU * 64) % 64 : 0;
  const tiltB = 2 * r * dpr > 700 ? -0.95 : 0.3; // big discs (orbit arrival): show mid-latitudes at the top limb
  const key = `disc|${id}|${S}|${lb}|${rq}|${clouds ? 1 : 0}|${id === 'earth' ? (mapsFor('earth').worldVer || 0) : 0}|${tiltB}`;
  const spr = cached(key, S, S, (g) => paintSphereSprite(g, S, id, look, lb, (rq / 64) * TAU, clouds, tiltB));
  if (spr) {
    const big = 2 * r * pad * dpr > S * 1.15;
    if (big) { ctx.save(); ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = 'high'; } catch { /* old */ } }
    ctx.drawImage(spr, cx - r * pad, cy - r * pad, 2 * r * pad, 2 * r * pad);
    if (big) { if (tiltB !== -0.95 || !drawDiscCap(ctx, id, look, cx, cy, r, lb, rq)) discDetail(ctx, id, look, cx, cy, r, lb); ctx.restore(); }
    return;
  }
  // no canvas support: simple shaded disc
  const L = light || SUN;
  const gr = ctx.createRadialGradient(cx + L.ax * r * 0.45, cy + L.ay * r * 0.45, r * 0.05, cx, cy, r);
  gr.addColorStop(0, look.palette[look.palette.length - 1]); gr.addColorStop(0.6, look.base); gr.addColorStop(1, '#000');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
}

/**
 * Crisp surface detail over an upscaled disc (orbit arrival: the planet fills the screen). A grey-centred
 * detail tile is laid in horizontal bands with spherical foreshortening (compressed toward the limb) and
 * blended with 'overlay', so it only modulates the lit sprite underneath.
 */
function discDetail(ctx, id, look, cx, cy, r, lb) {
  if (look.kind === 'gas' || look.kind === 'ring' || look.kind === 'cloudy' || look.kind === 'star' || look.kind === 'haze') return;
  const tile = detailTile(look.kind === 'earth' ? 'earthcloud' : id, 'fine', lb);
  if (!tile) return;
  const pat = patternOf(ctx, 'disc|' + id + '|' + lb, tile);
  if (!pat) return;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.999, 0, TAU); ctx.clip();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = look.kind === 'earth' ? 0.2 : 0.5;
  const tp = tile.width / (r * 0.22);
  const top = Math.max(cy - r, -40);
  const vh = ctx.canvas ? (ctx.canvas.height / devScale(ctx)) + 40 : cy + r;
  const bot = Math.min(cy + r, vh);
  for (let y = top; y < bot;) {
    const u = clamp((y - cy) / r, -0.999, 0.999), fz = Math.sqrt(1 - u * u);
    const bh = Math.max(2, 6 * fz + 1);
    const vtex = Math.asin(u) * r * tp;
    // pattern space → screen: x = cx + (px/tp), y = y + (py - vtex)*fz/tp
    if (setPatternMatrix(pat, 1 / tp, 0, 0, fz / tp, cx, y - (vtex * fz) / tp)) { ctx.fillStyle = pat; ctx.fillRect(cx - r, y, 2 * r, bh + 0.5); }
    y += bh;
  }
  ctx.restore();
}

// ------------------------------------------------------------------ big-disc cap (orbit arrival, screen resolution)

/**
 * Europa-style lineae: seeded great-circle arcs (gently warped). Returns { band, crest } at unit vector p:
 * band = 0..1 inside the dark reddish-brown double ridge, crest = 0..1 on the bright central ridge line.
 * minW = minimum half-width (radians) so the arcs never alias below one texel/pixel.
 */
const ARCS = new Map();
function arcsOf(id, n) {
  const key = id + '|' + n;
  let a = ARCS.get(key);
  if (a) return a;
  const R = rng(hash(id + '|lineae'));
  a = [];
  for (let i = 0; i < n; i++) {
    const z = R() * 2 - 1, ph = R() * TAU, s = Math.sqrt(1 - z * z);
    const nrm = [s * Math.cos(ph), z, s * Math.sin(ph)];
    // a point on the circle (orthogonal to nrm) = arc centre
    let t = [-nrm[2], 0, nrm[0]]; const tl = Math.hypot(t[0], t[2]) || 1; t = [t[0] / tl, 0, t[2] / tl];
    const b = [nrm[1] * t[2] - nrm[2] * t[1], nrm[2] * t[0] - nrm[0] * t[2], nrm[0] * t[1] - nrm[1] * t[0]];
    const th = R() * TAU, ctr = [t[0] * Math.cos(th) + b[0] * Math.sin(th), t[1] * Math.cos(th) + b[1] * Math.sin(th), t[2] * Math.cos(th) + b[2] * Math.sin(th)];
    const big = R() < 0.18;
    a.push({ n: nrm, c: ctr, cosL: Math.cos((big ? 0.7 : 0.15) + R() * (big ? 1.1 : 0.55)), w: (big ? 0.0018 : 0.0006) + R() * (big ? 0.0022 : 0.0012), dark: big ? 0.8 : 0.4 + R() * 0.4, ph: R() * 50 });
  }
  ARCS.set(key, a);
  return a;
}
function lineaeAt(x, y, z, arcs, minW, seed) {
  const wx = gn3(x * 4, y * 4, z * 4, seed) * 0.03 + gn3(x * 13, y * 13, z * 13, seed + 1) * 0.006, wy = gn3(x * 4 + 9, y * 4, z * 4, seed) * 0.03; // cycloid-like wander
  let band = 0, crest = 0;
  for (let i = 0; i < arcs.length; i++) {
    const A = arcs[i];
    const along = x * A.c[0] + y * A.c[1] + z * A.c[2];
    if (along < A.cosL) continue;
    const s = Math.abs(x * A.n[0] + y * A.n[1] + z * A.n[2] + wx * A.n[0] + wy * A.n[2]);
    // width swells and pinches along the ridge, edges are ragged, and the band is a DOUBLE ridge: two dark
    // reddish flanks with a paler medial line (no tube shading anywhere)
    const pinch = 0.45 + 0.9 * (0.5 + 0.5 * gn3(along * 40 + A.ph, A.ph, 0.3, seed + 7));
    const w = Math.max(minW, A.w * pinch);
    if (s > w * 2) continue;
    const fadeEnd = sstep(A.cosL, A.cosL + (1 - A.cosL) * 0.25, along);
    const rag = gn3(x * 900, y * 900, z * 900, seed + 9) * 0.35 * w;
    const sr = s + rag;
    const b = (1 - sstep(w * 0.7, w * 1.3, sr)) * A.dark * fadeEnd * Math.min(1, (A.w * pinch) / w) * (A.w > minW * 1.5 ? 0.62 + 0.38 * sstep(w * 0.08, w * 0.4, sr) : 1); // sub-pixel arcs fade, never fatten
    if (b > band) band = b;
    const cr = (1 - sstep(w * 0.12, w * 0.32, s)) * fadeEnd * (A.w > minW * 1.5 ? 1 : 0);
    if (cr > crest) crest = cr;
  }
  return { band, crest };
}

/**
 * Procedural crater height + ejecta brightness on a local tangent chart (u, v in radians). Several size
 * classes on jittered grids; dens(u, v, radius) → 0..1 keeps maria / ice smooth. Returns via CR.
 */
const CR = { h: 0, b: 0 };
function craterSum(u, v, classes, seed, densAt) {
  let h = 0, b = 0;
  for (let ci = 0; ci < classes.length; ci++) {
    const C = classes[ci], c = C.cell;
    const iu = Math.floor(u / c), iv = Math.floor(v / c);
    for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
      const hs = h32(iu + du, iv + dv, ci + 1, seed);
      const p = (hs & 1023) / 1024;
      if (p > C.p * densAt) continue;
      const cu = (iu + du + ((hs >>> 10) & 255) / 256) * c, cv = (iv + dv + ((hs >>> 18) & 255) / 256) * c;
      const r = c * (0.18 + 0.32 * (((hs >>> 4) & 63) / 63));
      const dx = u - cu, dy = v - cv, d2 = (dx * dx + dy * dy) / (r * r);
      if (d2 > 6.5) continue;
      const deg = 0.2 + 0.8 * (((hs >>> 12) & 15) / 15); // degradation: old craters are shallow with soft rims
      const d = Math.sqrt(d2), dep = r * C.depth * deg, rw = 0.01 + 0.05 * (1 - deg);
      let dh = d < 1 ? (d2 - 1) * dep * (0.6 + 0.4 * deg) + 0.2 * dep : 0.2 * dep * Math.pow(d, -3);
      dh += 0.13 * dep * Math.exp(-((d - 1) * (d - 1)) / rw);
      h += dh;
      if (((hs >>> 26) & 15) < C.fresh) b += (d < 1 ? 0.06 : 0.16 * Math.exp(-(d - 1) * 2.4)); // young crater: bright ejecta
      else if (d < 1) b -= 0.02 * (1 - d2);
    }
  }
  CR.h = h; CR.b = b;
}

const CAPS = new Map(); // id -> { best, building }
let CAP_LIVE_BUDGET = 9;

/** Builds rows [j0, j1) of a cap job (see drawDiscCap). */
function capRows(job, j0, j1) {
  const { W, Hh, img, id, look, maps, L, lon0, nx0, ny0, step, cbt, sbt, Hs, Uu, Vv, classes, seed, arcs, minW } = job;
  const d = img.data;
  const { w: MW, h: MH, col, gx, gy, alb } = maps;
  const kind = look.kind, icy = kind === 'icy', atm = look.atmosphere, AC = atm ? rgbOf(atm.color) : null;
  const moon = id === 'moon', europa = id === 'europa';
  const noiseAmp = icy ? 0.0012 : 0.0028, nF = 38;
  // pass 1: height + albedo detail per pixel (one extra row/col of margin for the gradients)
  const ja = Math.max(0, j0 - 1), jb = Math.min(Hh, j1 + 1);
  for (let j = ja; j < jb; j++) {
    if (job.hDone[j]) continue;
    const y0 = ny0 + (j + 0.5) * step;
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const x0 = nx0 + (i + 0.5) * step;
      const q = x0 * x0 + y0 * y0;
      const qc = Math.min(0.9999, q), zs = Math.sqrt(1 - qc);
      // sphere point in body space (same rotation as renderSphere)
      const sc = q >= 1 ? 0.99995 / Math.sqrt(q) : 1, xq = x0 * sc, yq = y0 * sc;
      const zb = yq * sbt + zs * cbt, yb = -yq * cbt + zs * sbt;
      const lonV = Math.atan2(xq, zb) + lon0, lat = Math.asin(clamp(yb, -1, 1));
      const cl = Math.cos(lat), px = cl * Math.sin(lonV), py = Math.sin(lat), pz = cl * Math.cos(lonV);
      Uu[k] = lonV; Vv[k] = lat;
      if (q >= 1) { Hs[k] = 0; job.A[k] = 0; continue; }
      let hh = fbm3(px * nF, py * nF, pz * nF, 3, seed + 3) * noiseAmp;
      let ab = 0;
      if (classes.length) {
        let dens = 1;
        if (moon || icy || look.kind === 'rocky') {
          const u = ((lonV / TAU + 0.5) % 1 + 1) % 1 * MW, v = (0.5 - lat / Math.PI) * MH;
          const a = sample1(alb, MW, MH, u, v);
          if (moon) dens = sstep(0.3, 0.55, a) * 0.85 + 0.15; // maria: few craters
        }
        craterSum(lonV * cl, lat, classes, seed, dens);
        hh += CR.h; ab += CR.b;
      }
      if (arcs) {
        const la = lineaeAt(px, py, pz, arcs, minW, seed + 5);
        ab -= la.band * 0.5; // flat albedo bands: lineae are stains, not tubes
      }
      Hs[k] = hh; job.A[k] = ab;
    }
    job.hDone[j] = 1;
  }
  // pass 2: shade
  const invStep = 1 / step;
  for (let j = j0; j < j1; j++) {
    const y0 = ny0 + (j + 0.5) * step;
    for (let i = 0; i < W; i++) {
      const k = j * W + i, o = k * 4;
      const x0 = nx0 + (i + 0.5) * step;
      const q = x0 * x0 + y0 * y0;
      const dn = Math.sqrt(q);
      const aa = step * 1.2;
      if (dn > 1 + aa * 0.5) { d[o + 3] = 0; continue; }
      const qq = Math.min(0.9999, q), zs = Math.sqrt(1 - qq);
      const lonV = Uu[k], lat = Vv[k];
      const u = ((lonV / TAU + 0.5) % 1 + 1) % 1 * MW, v = (0.5 - lat / Math.PI) * MH;
      sample3(col, MW, MH, u, v);
      let cr = SMP[0], cg = SMP[1], cb = SMP[2];
      // detail gradient (screen units → surface gradient on the unit sphere; g⁻¹ = I − p pᵀ)
      const kl = i > 0 ? k - 1 : k, kr = i < W - 1 ? k + 1 : k, ku = j > 0 ? k - W : k, kd = j < Hh - 1 ? k + W : k;
      let Hx = (Hs[kr] - Hs[kl]) * invStep / ((kr - kl) || 1), Hy = (Hs[kd] - Hs[ku]) * invStep / (((kd - ku) / W) || 1);
      // map relief (low frequency) adds to it, softly
      const mgx = sample1(gx, MW, MH, u, v) * 0.35, mgy = sample1(gy, MW, MH, u, v) * 0.35;
      const pr = x0 * Hx + y0 * Hy;
      const a = Hx - x0 * pr, b = Hy - y0 * pr;
      const iz = 1 / Math.max(0.04, zs);
      let nx = x0 - a, ny = y0 - b, nz = zs + (a * x0 + b * y0) * iz;
      // low-frequency map gradient in the lon/lat frame (as renderSphere, weaker)
      const clon = Math.cos(lonV - lon0), slon = Math.sin(lonV - lon0), cla = Math.cos(lat), sla = Math.sin(lat);
      const ex = clon, ey = -slon * sbt, ez = -slon * cbt;
      const tnx = -sla * slon, tny = -cla * cbt - sla * clon * sbt, tnz = cla * sbt - sla * clon * cbt;
      nx -= mgx * ex + mgy * tnx; ny -= mgx * ey + mgy * tny; nz -= mgx * ez + mgy * tnz;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const mu0 = nx * L[0] + ny * L[1] + nz * L[2];
      const mus = x0 * L[0] + y0 * L[1] + zs * L[2];
      const m0 = Math.max(0, mu0);
      let E;
      if (atm) E = Math.pow(m0, 0.9) * sstep(-0.06, 0.12, mus) * 1.12;
      else E = (1.25 * m0 / (m0 + zs * 0.85 + 0.04) + 0.35 * m0) * sstep(-0.05, 0.1, mus);
      E += 0.028; // earthshine / skylight: the night side is never pure black
      const alb = clamp(1 + job.A[k], 0.35, 1.6);
      cr *= E * alb; cg *= E * alb; cb *= E * alb;
      if (europa && job.A[k] < -0.05) { const t = clamp(-job.A[k] * 1.4, 0, 1); cr = lerp(cr, 140 * E, t * 0.6); cg = lerp(cg, 82 * E, t * 0.6); cb = lerp(cb, 52 * E, t * 0.6); }
      if (atm) {
        const lit = sstep(-0.3, 0.35, mus), rim = Math.pow(1 - zs, 3.2), kk = 0.35 * lit;
        cr += AC[0] * rim * kk; cg += AC[1] * rim * kk; cb += AC[2] * rim * kk;
      }
      d[o] = cr > 255 ? 255 : cr; d[o + 1] = cg > 255 ? 255 : cg; d[o + 2] = cb > 255 ? 255 : cb;
      d[o + 3] = 255 * clamp((1 + aa * 0.5 - dn) / aa, 0, 1);
    }
  }
}

function capJob(id, look, lb, rot, rB, dpr, rect) {
  const maps = mapsFor(id);
  const step = 1 / (rB * dpr);
  const W = Math.max(8, Math.min(1800, Math.ceil((rect[2] - rect[0]) / step)));
  const Hh = Math.max(8, Math.min(1400, Math.ceil((rect[3] - rect[1]) / step)));
  const c = makeCanvas(W, Hh);
  const g = c && c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(W, Hh);
  const N = W * Hh;
  const icy = look.kind === 'icy';
  const pxRad = step; // one device pixel in radians on the sphere (at the disc centre)
  // crater classes: cell size in radians; drop classes smaller than ~3 device px
  const dens = look.craters ?? 0.3;
  const all = id === 'europa' ? [{ cell: 0.06, p: 0.08, depth: 0.25, fresh: 6 }, { cell: 0.02, p: 0.05, depth: 0.3, fresh: 4 }]
    : id === 'mars' ? [{ cell: 0.045, p: 0.35, depth: 0.22, fresh: 1 }, { cell: 0.018, p: 0.4, depth: 0.25, fresh: 1 }, { cell: 0.0072, p: 0.45, depth: 0.25, fresh: 2 }]
    : [{ cell: 0.11, p: 0.35 * dens, depth: 0.32, fresh: 1 }, { cell: 0.045, p: 0.5 * dens, depth: 0.4, fresh: 2 }, { cell: 0.018, p: 0.6 * dens, depth: 0.45, fresh: 2 }, { cell: 0.0072, p: 0.65 * dens, depth: 0.45, fresh: 3 }, { cell: 0.0029, p: 0.6 * dens, depth: 0.45, fresh: 3 }];
  const classes = (look.kind === 'gas' ? [] : all).filter((C) => C.cell * 0.18 > pxRad * 1.5 && C.p > 0.01).map((C) => (icy && id !== 'europa' ? { ...C, depth: C.depth * 0.6 } : C));
  const L = sun3(bucketLight(lb), 0.42);
  const tiltB = -0.95;
  return {
    c, g, img, W, Hh, id, look, maps, L, lon0: (look.lon0 || 0) * D2R + rot, nx0: rect[0], ny0: rect[1], step, rect, rB,
    cbt: Math.cos(tiltB), sbt: Math.sin(tiltB), Hs: new Float32Array(N), A: new Float32Array(N), Uu: new Float32Array(N), Vv: new Float32Array(N),
    hDone: new Uint8Array(Hh), rows: 0, classes, seed: hash(id + '|cap'),
    arcs: id === 'europa' ? arcsOf(id, 260) : null, minW: Math.max(pxRad * 0.7, 0.0006),
  };
}

/**
 * Draws the visible part of a big disc at screen resolution (orbit arrival): procedural craters / lineae /
 * regolith detail over the smooth base map, normals from the detail height field, same lighting as the
 * sprite. Generated progressively (a few ms per frame when live) in normalised disc coordinates, so a cap
 * built for one radius is reused, rescaled, for the next until the sharper one is complete.
 */
function drawDiscCap(ctx, id, look, cx, cy, r, lb, rq) {
  if (look.kind === 'gas' || look.kind === 'ring' || look.kind === 'cloudy' || look.kind === 'star' || look.kind === 'haze' || look.kind === 'earth') return false;
  if (typeof document === 'undefined' && typeof OffscreenCanvas !== 'function') return false;
  const dpr = devScale(ctx);
  let vw = 4000, vh = 4000;
  try { const m = ctx.getTransform(); vw = ctx.canvas.width / (m.a || 1) - m.e / (m.a || 1); vh = ctx.canvas.height / (m.d || 1) - m.f / (m.d || 1); } catch { /* keep */ }
  const q = (v, s) => Math.floor(v / s) * s;
  const nx0 = Math.max(-1, q((0 - cx) / r - 0.04, 0.05)), nx1 = Math.min(1, -q(-((vw - cx) / r + 0.04), 0.05));
  const ny0 = Math.max(-1, q((0 - cy) / r - 0.04, 0.05)), ny1 = Math.min(1, -q(-((vh - cy) / r + 0.04), 0.05));
  if (nx1 <= nx0 || ny1 <= ny0) return true;
  const rB = Math.round(Math.pow(1.3, Math.ceil(Math.log(r) / Math.log(1.3))));
  const key = `${id}|${lb}|${rq}|${rB}|${dpr}|${nx0.toFixed(2)},${ny0.toFixed(2)},${nx1.toFixed(2)},${ny1.toFixed(2)}`;
  let st = CAPS.get(id);
  if (!st) { st = { best: null, building: null }; CAPS.set(id, st); }
  if (st.best && st.best.key !== key && st.best.lbq !== `${lb}|${rq}`) st.best = null;
  if (!st.best || st.best.key !== key) {
    if (!st.building || st.building.key !== key) {
      const job = capJob(id, look, lb, (rq / 64) * TAU, rB, dpr, [nx0, ny0, nx1, ny1]);
      if (!job) return false;
      job.key = key; job.lbq = `${lb}|${rq}`;
      st.building = job;
    }
    const job = st.building;
    const live = liveFrames >= 3;
    const t0 = nowMs();
    const startRow = job.rows;
    while (job.rows < job.Hh) {
      const n = Math.min(job.Hh - job.rows, 8);
      capRows(job, job.rows, job.rows + n);
      job.rows += n;
      if (live && nowMs() - t0 > CAP_LIVE_BUDGET) break;
    }
    if (job.rows > startRow) job.g.putImageData(job.img, 0, 0, 0, startRow, job.W, job.rows - startRow);
    if (job.rows >= job.Hh) { st.best = job; st.building = null; job.Hs = job.A = job.Uu = job.Vv = null; }
  }
  const draw = (jb, rows) => {
    if (!jb || rows <= 0) return;
    const [ax0, ay0, ax1, ay1] = jb.rect;
    const sh = rows / jb.Hh;
    ctx.save();
    ctx.imageSmoothingEnabled = true; try { ctx.imageSmoothingQuality = 'high'; } catch { /* old */ }
    ctx.drawImage(jb.c, 0, 0, jb.W, rows, cx + ax0 * r, cy + ay0 * r, (ax1 - ax0) * r, (ay1 - ay0) * r * sh);
    ctx.restore();
  };
  if (st.best) draw(st.best, st.best.Hh);
  if (st.building) draw(st.building, st.building.rows);
  return true;
}

// ------------------------------------------------------------------ Earth limb (ray-traced, cached per altitude bucket)

const LIMB_ALTS = [16, 20, 24, 30, 38, 48, 60, 75, 95, 120, 150, 190, 240, 300, 380, 480, 600, 760, 960, 1200, 1500, 1900, 2400];
const LIMB_CURV = 2.2; // curvature exaggeration (readable horizon arc on a phone)
const LIMB_SITE = { lat: 28.5, lon: -80.6, head: 90 }; // Cape Canaveral, looking east (downrange)

/** Ray-traces the curved Earth below a camera at altKm into an RGBA buffer (SW×SH, horizon at rowHor). */
function renderLimb(buf, SW, SH, rowHor, altKm, L3, j0 = 0, j1 = SH) {
  const m = mapsFor('earth');
  const Re = 6371 / LIMB_CURV, h = Math.max(1, altKm), Rc = Re + h;
  const dip = Math.acos(Re / Rc), tdip = Math.tan(dip);
  const F = (SW / 2) / Math.tan((76 * D2R) / 2);
  const up0 = unitOf(LIMB_SITE.lat, LIMB_SITE.lon), la = LIMB_SITE.lat * D2R, lo = LIMB_SITE.lon * D2R;
  const east0 = [Math.cos(lo), 0, -Math.sin(lo)], north0 = [-Math.sin(la) * Math.sin(lo), Math.cos(la), -Math.sin(la) * Math.cos(lo)];
  const { w: MW, h: MH, col, cloud, cw: CW, ch: CH, spec } = m;
  const camHaze = 1 + Math.max(0, 70 - h) / 25;
  const out = [0, 0, 0, 0];
  // shades one ray through image position (fi, fj) → out (straight rgba, a 0..1); returns true if it hits the ground
  const ray = (fi, fj) => {
    let dx = (fi - SW / 2) / F, dy = -tdip - (fj - rowHor) / F, dz = 1;
    const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
    const bq = Rc * dy, cq = Rc * Rc - Re * Re, disc = bq * bq - cq;
    if (disc > 0 && -bq - Math.sqrt(disc) > 0) {
      const t = -bq - Math.sqrt(disc);
      const Px = t * dx, Py = Rc + t * dy, Pz = t * dz;
      const nx = Px / Re, ny = Py / Re, nz = Pz / Re;
      // local camera frame (x = south, y = up, z = east) → map space
      const ex = up0[0] * ny + east0[0] * nz - north0[0] * nx, ey = up0[1] * ny + east0[1] * nz - north0[1] * nx, ez = up0[2] * ny + east0[2] * nz - north0[2] * nx;
      const lat = Math.asin(clamp(ey, -1, 1)), lon = Math.atan2(ex, ez);
      const u = (lon / TAU + 0.5) * MW, v = (0.5 - lat / Math.PI) * MH;
      sample3(col, MW, MH, u, v);
      const det = fbm3(ex * 260, ey * 260, ez * 260, 2, 91);
      let cr = SMP[0] * (1 + det * 0.18), cg = SMP[1] * (1 + det * 0.18), cb = SMP[2] * (1 + det * 0.15);
      const cbase = sample1(cloud, CW, CH, u * (CW / MW), v * (CH / MH));
      const cdet = fbm3(ex * 120 + 3, ey * 120, ez * 120, 3, 93);
      // clustered cloud systems: the large-scale map decides where (fronts, ITCZ), the detail only frays the edges
      // and adds cumulus streets inside, so open ocean stays clear instead of salt-and-pepper speckle
      const streets = 0.5 + 0.5 * Math.sin((ex * 900 + ez * 300) + cdet * 6);
      const cl = sstep(0.16, 0.52, cbase * 1.1 + cdet * 0.32 + 0.1) * (0.7 + 0.3 * sstep(-0.2, 0.3, cdet)) * (0.8 + 0.2 * streets);
      const mu0 = nx * L3[0] + ny * L3[1] + nz * L3[2];
      const E = Math.max(0, mu0) * 1.15 + 0.05;
      cr *= E; cg *= E; cb *= E;
      const sp = sample1(spec, MW, MH, u, v) * (1 - cl);
      if (sp > 0.02) {
        let hx = L3[0] - dx, hy = L3[1] - dy, hz = L3[2] - dz; const hn = Math.hypot(hx, hy, hz) || 1; hx /= hn; hy /= hn; hz /= hn;
        const hd = Math.max(0, nx * hx + ny * hy + nz * hz);
        const s2 = sp * (Math.pow(hd, 160) * 300 + Math.pow(hd, 20) * 45);
        cr += s2; cg += s2 * 0.95; cb += s2 * 0.85;
      }
      const cE = 0.18 + 0.95 * Math.max(0, mu0) * (0.85 + cdet * 0.3);
      cr = lerp(cr, 248 * cE, cl); cg = lerp(cg, 250 * cE, cl); cb = lerp(cb, 255 * cE, cl);
      const cosv = Math.max(0.015, -(nx * dx + ny * dy + nz * dz));
      const hz = 1 - Math.exp(-(0.16 * camHaze) / cosv);
      const sk = 0.45 + 0.55 * Math.max(0, mu0 + 0.2);
      cr = lerp(cr, 120 * sk, hz); cg = lerp(cg, 172 * sk, hz); cb = lerp(cb, 238 * sk, hz);
      out[0] = cr > 255 ? 255 : cr; out[1] = cg > 255 ? 255 : cg; out[2] = cb > 255 ? 255 : cb; out[3] = 1;
      return true;
    }
    const tc = -bq;
    let hmin;
    if (tc > 0) { const qx = tc * dx, qy = Rc + tc * dy, qz = tc * dz; hmin = Math.hypot(qx, qy, qz) - Re; } else hmin = h;
    const gl = Math.exp(-Math.max(0, hmin) / 10.5);
    const k = sstep(0, 45, hmin);
    out[0] = lerp(205, 30, k); out[1] = lerp(232, 90, k); out[2] = lerp(255, 225, k);
    // feather the sprite's top rows: the glow must fade into the sky gradient, never end in a straight seam
    out[3] = clamp(gl * 1.25 + Math.exp(-Math.max(0, hmin) / 38) * 0.18, 0, 1) * sstep(0, rowHor * 0.45, fj);
    return false;
  };
  // the limb edge: analytic test of the 4 pixel corners; mixed pixels are supersampled 4×4 (anti-aliased arc)
  const hits = (fi, fj) => { let dx = (fi - SW / 2) / F, dy = -tdip - (fj - rowHor) / F; const dl = Math.hypot(dx, dy, 1); dy /= dl; const bq = Rc * dy; return bq * bq - (Rc * Rc - Re * Re) > 0 && bq < 0; };
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < SW; i++) {
      const o = (j * SW + i) * 4;
      const c0 = hits(i, j), c1 = hits(i + 1, j), c2 = hits(i, j + 1), c3 = hits(i + 1, j + 1);
      if (c0 === c1 && c0 === c2 && c0 === c3) {
        ray(i + 0.5, j + 0.5);
        buf[o] = out[0]; buf[o + 1] = out[1]; buf[o + 2] = out[2]; buf[o + 3] = out[3] * 255;
        continue;
      }
      let r = 0, g = 0, bb = 0, al = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        ray(i + (sx + 0.5) / 4, j + (sy + 0.5) / 4);
        r += out[0] * out[3]; g += out[1] * out[3]; bb += out[2] * out[3]; al += out[3];
      }
      if (al > 0) { buf[o] = r / al; buf[o + 1] = g / al; buf[o + 2] = bb / al; }
      buf[o + 3] = (al / 16) * 255;
    }
  }
}

const LAST_LIMB = { c: null, sh: 0 };
function earthLimbGeom(dpr, W, H) {
  const SW = Math.round(clamp(W * dpr * (dpr > 1.5 ? 0.36 : 0.44), 208, 360) / 16) * 16; // phones: lighter sprite
  const scale = W / SW;
  const rowHor = Math.round(SW * 0.2);
  const SH = Math.ceil((rowHor + (H * 0.34 + 24) / scale) / 32) * 32; // fixed per view: no regen while the horizon moves
  return { SW, SH, scale, rowHor };
}
const earthL3 = (lb) => { const L0 = bucketLight(lb); const sx = L0.ax, sy = -L0.ay, sz = 0.55; const n = Math.hypot(sx, sy, sz); return [sx / n, sy / n, sz / n]; };
/**
 * One idle slice of prebuilding what a flight will need (call from requestIdleCallback until it returns true):
 * Earth maps (async generator), the Earth-limb altitude buckets of the climb, the target body's maps.
 */
export function prewarmEarthLimb(dpr, view, altsKm = [], light = SUN) {
  const W = num(view?.W, 375), H = num(view?.H, 700);
  if (!buildMapsStep('earth', 8)) return false;
  const { SW, SH, rowHor } = earthLimbGeom(clamp(num(dpr, 1), 1, 2), W, H);
  const lb = lightBucket(light), L3 = earthL3(lb);
  const mver = mapsFor('earth').worldVer || 0;
  for (const a of altsKm) {
    const key = `limb|${a}|${SW}|${SH}|${lb}|${mver}`;
    if (ready(key)) continue;
    progressive(key, SW, SH, () => (d, j0, j1) => renderLimb(d, SW, SH, rowHor, a, L3, j0, j1), { idle: true, chunk: 4 });
    return false;
  }
  return true;
}
/**
 * One idle slice of prebuilding the small sprites a scene will need (cloud decks for the climb, boulders for a
 * landing world): builds one sprite per call, returns true when all are cached.
 */
export function prewarmSprites({ clouds = false, rocksWorld = null, light = SUN } = {}) {
  const lb = lightBucket(light);
  if (clouds) for (const kind of ['cu', 'st', 'ci']) for (let v = 0; v < 4; v++) { if (!CACHE.has(`cloud3|${kind}|${v}|${lb}`)) { cloudSprite(kind, v, lb); return false; } }
  if (rocksWorld) for (let v = 0; v < 4; v++) { if (!CACHE.has(`rock|${rocksWorld}|${v}|${lb}`)) { rockSprite(rocksWorld, v, lb); return false; } }
  return true;
}
/** One idle slice of building a body's planet maps. */
export function prewarmMaps(id) { return buildMapsStep(id, 8); }
export const LIMB_BUCKETS = Object.freeze([16, 20, 24, 30, 38, 48, 60, 75, 95, 120, 150, 190, 240]);
/** Curved Earth below the camera at altKm. Returns { horizonY } (screen y of the limb at centre). */
export function drawEarthLimb(ctx, view, { altKm = 0, light = SUN, t = 0, tilt = 0 } = {}) {
  void t; void tilt;
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const alt = Math.max(0, num(altKm));
  if (alt < 14) return { horizonY: H * 2 };
  ensureWorld();
  // the curved horizon rises into the bottom of the frame from ~15 km (thin blue limb) and settles at 2/3 by orbit
  const k = sstep(14, 115, alt);
  const horizonY = lerp(H * 1.0, H * 0.66, k);
  const fadeIn = sstep(14, 30, alt);
  const { SW, SH, scale, rowHor } = earthLimbGeom(devScale(ctx), W, H);
  const lb = lightBucket(light);
  const L0 = bucketLight(lb);
  const L3 = (() => { const sx = L0.ax, sy = -L0.ay, sz = 0.55; const n = Math.hypot(sx, sy, sz); return [sx / n, sy / n, sz / n]; })();
  // altitude bucket pair (log interpolation)
  let i1 = LIMB_ALTS.findIndex((a) => a >= alt);
  if (i1 < 0) i1 = LIMB_ALTS.length - 1;
  const i0 = Math.max(0, i1 - 1);
  const a0 = LIMB_ALTS[i0], a1 = LIMB_ALTS[i1];
  const wgt = a1 === a0 ? 0 : clamp(Math.log(alt / a0) / Math.log(a1 / a0), 0, 1);
  const mver = mapsFor('earth').worldVer || 0;
  // ray-traced progressively (≤ ~7 ms per frame while live); until ready the last sprite (or a gradient) stands in
  const spr = (a) => progressive(`limb|${a}|${SW}|${SH}|${lb}|${mver}`, SW, SH, () => (d, j0, j1) => renderLimb(d, SW, SH, rowHor, a, L3, j0, j1), { chunk: 4 });
  const top = horizonY - rowHor * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  let s0 = spr(a0);
  if (s0) LAST_LIMB.c = s0; else if (LAST_LIMB.c && LAST_LIMB.c.width === SW) s0 = LAST_LIMB.c;
  if (s0) {
    ctx.globalAlpha = fadeIn;
    ctx.drawImage(s0, 0, top, W, s0.height * scale);
    if (wgt > 0.02 && a1 !== a0) { const s1 = spr(a1); if (s1) { ctx.globalAlpha = fadeIn * wgt; ctx.drawImage(s1, 0, top, W, s1.height * scale); } }
    const bot = top + s0.height * scale;
    if (bot < H) { ctx.globalAlpha = fadeIn; ctx.fillStyle = '#123a5e'; ctx.fillRect(0, bot - 1, W, H - bot + 2); }
  } else {
    const g = ctx.createLinearGradient(0, horizonY, 0, H);
    g.addColorStop(0, '#9cc4ec'); g.addColorStop(0.08, '#2a6db0'); g.addColorStop(1, '#0d3a66');
    ctx.globalAlpha = fadeIn; ctx.fillStyle = g; ctx.fillRect(0, horizonY, W, H - horizonY);
  }
  ctx.restore();
  return { horizonY };
}

// ------------------------------------------------------------------ progressive textures (row jobs, ≤ ~7 ms per frame)

const PJOBS = new Map(); // key -> { c, g, img, rows, H, W, rowsFn }
let PJ_SPENT = 0, PJ_WIN = -1e9;
const PJ_BUDGET = 7;
/**
 * A texture painted row by row: make() returns rowsFn(data, j0, j1, w, h), which fills rows [j0, j1) of an RGBA
 * buffer. While a live animation runs, all jobs together advance at most ~7 ms per frame and this returns null
 * until the texture is complete; a one-off draw (tests, screenshots) builds it at once. `idle` = called from an
 * idle callback (prewarm): one ~8 ms slice. Finished canvases go into the LRU cache under `key`.
 */
function progressive(key, w, h, make, { idle = false, chunk = 8 } = {}) {
  const hit = CACHE.get(key);
  if (hit) { CACHE.delete(key); CACHE.set(key, hit); return hit.canvas; }
  let job = PJOBS.get(key);
  if (!job) {
    const c = makeCanvas(w, h);
    const g = c && c.getContext('2d');
    if (!g) return null;
    let rowsFn = null;
    try { rowsFn = make(); } catch (e) { console.error('launch-render progressive', key, e); return null; }
    job = { c, g, img: g.createImageData(c.width, c.height), rows: 0, H: c.height, W: c.width, rowsFn };
    PJOBS.set(key, job);
  }
  const live = liveFrames >= 3;
  const t0 = nowMs();
  if (t0 - PJ_WIN > 12) PJ_SPENT = 0;
  const limit = idle ? 8 : live ? Math.max(0.5, PJ_BUDGET - PJ_SPENT) : Infinity;
  while (job.rows < job.H) {
    const n = Math.min(job.H - job.rows, chunk);
    try { job.rowsFn(job.img.data, job.rows, job.rows + n, job.W, job.H); } catch (e) { console.error('launch-render progressive', key, e); job.rows = job.H; break; }
    job.rows += n;
    if (nowMs() - t0 >= limit) break;
  }
  if (!idle && live) { PJ_SPENT += nowMs() - t0; PJ_WIN = nowMs(); }
  if (job.rows < job.H) return null;
  job.g.putImageData(job.img, 0, 0);
  PJOBS.delete(key);
  const bytes = job.W * job.H * 4;
  CACHE.set(key, { canvas: job.c, bytes });
  cacheBytes += bytes;
  for (const [k, v] of CACHE) { if (cacheBytes <= CACHE_BUDGET || k === key) break; CACHE.delete(k); cacheBytes -= v.bytes; }
  return job.c;
}
const ready = (key) => CACHE.has(key);

// ------------------------------------------------------------------ curved limb of a landing world (suborbital view)

/** Mean radii (km) of landing worlds. The limb view shrinks big bodies so the curvature reads on a phone. */
const BODY_RKM = { moon: 1737, mars: 3390, mercury: 2440, europa: 1561, titan: 2575, venus: 6052, ganymede: 2634, callisto: 2410, io: 1822, enceladus: 252, triton: 1353, pluto: 1188, charon: 606, ceres: 470, vesta: 263, phobos: 11, deimos: 6, generic: 1500 };
/** Landing site under the descent (lat, lon deg, body map coordinates): Tranquility Base, Jezero, ... */
const BODY_SITE = { moon: [0.7, 23.5], mars: [18.4, 77.5], mercury: [10, 20], europa: [5, 180], titan: [-10, 165], io: [5, 10], ganymede: [10, 0], callisto: [10, 0] };
const BLIMB_ALTS = [2, 3, 4.5, 7, 10, 15, 22, 33, 50, 75, 110, 160, 240, 360];
/** Atmospheric haze per world: k (vertical optical depth), scale height (km), haze and limb-glow colours. */
const BODY_AIR = {
  mars: { k: 0.2, Hs: 11, col: [206, 152, 106], glow: [222, 172, 122] },
  titan: { k: 1.6, Hs: 40, col: [204, 146, 68], glow: [222, 160, 80] },
  venus: { k: 2.5, Hs: 16, col: [230, 205, 150], glow: [240, 220, 170] },
};

function bodyLimbRows(world, a, SW, SH, rowHor, L3, F) {
  const id = BODY_LOOK[world] ? world : 'generic';
  const look = BODY_LOOK[id];
  const m = mapsFor(id);
  const Rb = BODY_RKM[id] || 1500;
  const Re = Math.min(Rb, 900 + Rb * 0.1); // displayed radius (km): curvature exaggeration for big worlds
  const scaleK = Rb / Re;
  const h = Math.max(0.5, a), Rc = Re + h;
  const dip = Math.acos(Re / Rc), tdip = Math.tan(dip);
  const site = BODY_SITE[id] || [0, 0];
  const up0 = unitOf(site[0], site[1]), la = site[0] * D2R, lo = site[1] * D2R;
  const east0 = [Math.cos(lo), 0, -Math.sin(lo)], north0 = [-Math.sin(la) * Math.sin(lo), Math.cos(la), -Math.sin(la) * Math.cos(lo)];
  const { w: MW, h: MH, col } = m;
  const air = BODY_AIR[id] || null;
  const fam = terrainFamily(id);
  const dens = look.craters ?? 0.3;
  // crater classes (cell = radians on the real body): a class only shows where its craters span a few pixels, so
  // the far field never aliases into stripes and the near field still gets small craters (power-law population)
  const base = fam === 'lunar' || fam === 'rubble' ? 1 : fam === 'mars' ? 0.5 : fam === 'ice' ? 0.22 : 0.06;
  const CL = [0.03, 0.015, 0.0075, 0.0037, 0.0019, 0.00095, 0.00048, 0.00024, 0.00012]
    .map((cell, i) => [{ cell, p: Math.min(0.8, (0.32 + i * 0.06) * dens * base * 1.3), depth: fam === 'mars' ? 0.2 : 0.38, fresh: 2 + (i > 4 ? 1 : 0) }]);
  const seed = hash(id + '|blimb');
  const N = SW * SH;
  const Hs = new Float32Array(N), FP = new Float32Array(N), CV = new Float32Array(N), AB = new Float32Array(N);
  const NX = new Float32Array(N), NY = new Float32Array(N), NZ = new Float32Array(N), BC = new Float32Array(N * 3);
  const done = new Uint8Array(SH);
  const haze = air ? (1 - Math.exp(-h / air.Hs) * 0.4) : 0;
  const pass1 = (j) => {
    if (done[j]) return;
    done[j] = 1;
    for (let i = 0; i < SW; i++) {
      const k = j * SW + i;
      let dx = (i + 0.5 - SW / 2) / F, dy = -tdip - (j + 0.5 - rowHor) / F, dz = 1;
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      const bq = Rc * dy, disc = bq * bq - (Rc * Rc - Re * Re);
      if (!(disc > 0 && -bq - Math.sqrt(disc) > 0)) {
        FP[k] = -1;
        const tc = -bq; let hmin = h;
        if (tc > 0) { const qx = tc * dx, qy = Rc + tc * dy, qz = tc * dz; hmin = Math.hypot(qx, qy, qz) - Re; }
        CV[k] = hmin;
        continue;
      }
      const t = -bq - Math.sqrt(disc);
      const nx = (t * dx) / Re, ny = (Rc + t * dy) / Re, nz = (t * dz) / Re;
      NX[k] = nx; NY[k] = ny; NZ[k] = nz;
      const cosv = Math.max(0.02, -(nx * dx + ny * dy + nz * dz));
      CV[k] = cosv;
      // camera frame (x = south, y = up, z = east, as the Earth limb) → body map space
      const ex = up0[0] * ny + east0[0] * nz - north0[0] * nx, ey = up0[1] * ny + east0[1] * nz - north0[1] * nx, ez = up0[2] * ny + east0[2] * nz - north0[2] * nx;
      const lat = Math.asin(clamp(ey, -1, 1)), lon = Math.atan2(ex, ez);
      sample3(col, MW, MH, (lon / TAU + 0.5) * MW, (0.5 - lat / Math.PI) * MH);
      BC[k * 3] = SMP[0]; BC[k * 3 + 1] = SMP[1]; BC[k * 3 + 2] = SMP[2];
      const fp = t / (F * Re); // radians of the displayed sphere per pixel (across)
      FP[k] = fp;
      const fpReal = (fp / cosv) / scaleK; // ... of the real body, along the line of sight (worst case)
      // the crater chart is anchored on the site: (east, north) offsets from it in radians of the real body
      const u = (nz) / scaleK, v = (-nx) / scaleK;
      let hh = 0, ab = 0;
      for (let c = 0; c < CL.length; c++) {
        const C = CL[c][0];
        const wgt = sstep(1.5, 5, (C.cell * 0.3) / fpReal);
        if (wgt < 0.02) continue;
        craterSum(u, v, CL[c], seed + c * 7, 1);
        hh += CR.h * wgt; ab += CR.b * wgt;
      }
      const g1 = sstep(1.5, 5, 0.0006 / fpReal), g2 = sstep(1.5, 5, 0.00008 / fpReal);
      if (g1 > 0) hh += gn3(u * 2600, v * 2600, 0.5, seed + 3) * 0.00012 * g1;
      if (g2 > 0) hh += gn3(u * 16000, v * 16000, 1.5, seed + 4) * 0.000022 * g2;
      if (fam === 'mars') ab += fbm3(ex * 160, ey * 160, ez * 160, 3, seed + 9) * 0.22;
      else if (fam === 'ice') { const cr = Math.abs(fbm3(ex * 60, ey * 60, ez * 60, 3, seed + 11)); ab -= (1 - sstep(0.0, 0.035, cr)) * 0.35; }
      else {
        ab += fbm3(ex * 220, ey * 220, ez * 220, 3, seed + 12) * 0.08;
        if (fam === 'lunar') { const mp = fbm3(ex * 22, ey * 22, ez * 22, 5, seed + 13); ab -= sstep(0.06, 0.13, mp) * 0.32; } // mare flows: dark, sharp-edged
      }
      Hs[k] = hh; AB[k] = ab;
    }
  };
  return (d, j0, j1) => {
    for (let j = Math.max(0, j0 - 1); j < Math.min(SH, j1 + 1); j++) pass1(j);
    for (let j = j0; j < j1; j++) {
      for (let i = 0; i < SW; i++) {
        const k = j * SW + i, o = k * 4;
        if (FP[k] < 0) { // sky above the limb: the thin atmosphere glows (airless worlds: nothing)
          if (!air) { d[o + 3] = 0; continue; }
          const al = clamp(Math.exp(-Math.max(0, CV[k]) / (air.Hs * 1.3)) * 1.05, 0, 1);
          d[o] = air.glow[0]; d[o + 1] = air.glow[1]; d[o + 2] = air.glow[2]; d[o + 3] = 255 * al;
          continue;
        }
        const fp = FP[k] / scaleK, cosv = CV[k];
        const kl = i > 0 && FP[k - 1] >= 0 ? k - 1 : k, kr = i < SW - 1 && FP[k + 1] >= 0 ? k + 1 : k;
        const ku = j > 0 && FP[k - SW] >= 0 ? k - SW : k, kd = j < SH - 1 && FP[k + SW] >= 0 ? k + SW : k;
        const Hx = kr === kl ? 0 : (Hs[kr] - Hs[kl]) / ((kr - kl) * fp);
        const Hf = kd === ku ? 0 : -(Hs[kd] - Hs[ku]) / ((((kd - ku) / SW) * fp) / cosv);
        const nx = NX[k], ny = NY[k], nz = NZ[k];
        let tx = 1 - nx * nx, ty = -nx * ny, tz = -nx * nz; let tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        let fx = -nz * nx, fy = -nz * ny, fz = 1 - nz * nz; tl = Math.hypot(fx, fy, fz) || 1; fx /= tl; fy /= tl; fz /= tl;
        const g1 = clamp(Hx, -2.5, 2.5), g2 = clamp(Hf, -2.5, 2.5);
        let mx = nx - g1 * tx - g2 * fx, my = ny - g1 * ty - g2 * fy, mz = nz - g1 * tz - g2 * fz;
        const ml = Math.hypot(mx, my, mz) || 1; mx /= ml; my /= ml; mz /= ml;
        const m0 = Math.max(0, mx * L3[0] + my * L3[1] + mz * L3[2]);
        const flat = nx * L3[0] + ny * L3[1] + nz * L3[2];
        let E = air ? Math.pow(m0, 0.9) * 1.1 + 0.1 : (1.25 * m0 / (m0 + cosv * 0.85 + 0.04) + 0.3 * m0) * sstep(-0.05, 0.08, flat);
        E += 0.025;
        const alb = clamp(1 + AB[k], 0.4, 1.6);
        let cr = BC[k * 3] * E * alb, cg = BC[k * 3 + 1] * E * alb, cb = BC[k * 3 + 2] * E * alb;
        if (air) {
          const hz = 1 - Math.exp(-air.k * haze * Math.min(14, 0.4 + 1 / cosv));
          cr = lerp(cr, air.col[0], hz); cg = lerp(cg, air.col[1], hz); cb = lerp(cb, air.col[2], hz);
        }
        d[o] = cr > 255 ? 255 : cr; d[o + 1] = cg > 255 ? 255 : cg; d[o + 2] = cb > 255 ? 255 : cb; d[o + 3] = 255;
      }
    }
  };
}

const LAST_BLIMB = new Map(); // world -> last complete sprite (shown while the next altitude bucket builds)
/** Sprite geometry for the body limb (fixed per view: altitude changes never resize it). */
function blimbGeom(ctx, W, H, horizonY) {
  const dpr = devScale(ctx);
  const SW = Math.round(clamp(W * dpr * (dpr > 1.5 ? 0.42 : 0.6), 192, 336) / 16) * 16;
  const scale = W / SW;
  const rowHor = Math.round(SW * 0.16);
  const SH = Math.ceil((rowHor + (H - horizonY + 4) / scale) / 16) * 16;
  return { SW, SH, scale, rowHor, F: (SW / 2) / Math.tan((70 * D2R) / 2) }; // wide lens: the limb visibly arcs
}
const blimbKey = (world, a, g, lb) => `blimb|${world}|${a}|${g.SW}|${g.SH}|${lb}`;
function blimbL3(lb) { const L0 = bucketLight(lb); const v = [L0.ax, 0.5, 0.3]; const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; }
const nearestBucket = (a) => BLIMB_ALTS.reduce((p, q) => (Math.abs(Math.log(q / a)) < Math.abs(Math.log(p / a)) ? q : p), BLIMB_ALTS[0]);

/**
 * Curved world seen from altitude during a descent (above ~3 km): the body's map with craters and albedo, real
 * (exaggerated) curvature, and a haze band for atmospheres (Mars butterscotch, Titan orange). horizonY = screen y
 * of the limb at the centre; alpha cross-fades with the perspective terrain. Returns true when drawn.
 */
export function drawBodyLimb(ctx, view, world, { altKm = 0, light = SUN, horizonY, alpha = 1 } = {}) {
  tick();
  const W = num(view?.W, 375), H = num(view?.H, 700);
  if (!(alpha > 0.01) || world === 'earth') return false;
  const hy = num(horizonY, H * 0.62);
  const g = blimbGeom(ctx, W, H, hy);
  const lb = lightBucket(light);
  const alt = clamp(num(altKm), BLIMB_ALTS[0], BLIMB_ALTS[BLIMB_ALTS.length - 1]);
  let i1 = BLIMB_ALTS.findIndex((a) => a >= alt); if (i1 < 0) i1 = BLIMB_ALTS.length - 1;
  const i0 = Math.max(0, i1 - 1), a0 = BLIMB_ALTS[i0], a1 = BLIMB_ALTS[i1];
  const wgt = a1 === a0 ? 0 : clamp(Math.log(alt / a0) / Math.log(a1 / a0), 0, 1);
  const L3 = blimbL3(lb);
  const spr = (a) => progressive(blimbKey(world, a, g, lb), g.SW, g.SH, () => bodyLimbRows(world, a, g.SW, g.SH, g.rowHor, L3, g.F), { chunk: 4 });
  // the nearer bucket first; the other one once the first is done and the blend actually needs it
  const near = wgt < 0.5 ? a0 : a1, other = near === a0 ? a1 : a0;
  const sN = spr(near);
  const sO = sN && (ready(blimbKey(world, other, g, lb)) || (wgt > 0.1 && wgt < 0.9)) ? spr(other) : null;
  const s0 = near === a0 ? sN : sO, s1 = near === a1 ? sN : sO;
  const top = hy - g.rowHor * g.scale;
  const fb = LAST_BLIMB.get(world);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  try { ctx.imageSmoothingQuality = 'high'; } catch { /* old */ }
  let drew = false;
  const blit = (c, a) => { if (!c || a <= 0.003) return; ctx.globalAlpha = alpha * a; ctx.drawImage(c, 0, top, W, c.height * g.scale); drew = true; };
  if (s0 && s1) { blit(s0, 1); blit(s1, wgt); } else if (s0 || s1) blit(s0 || s1, 1);
  else if (fb && fb.width === g.SW && fb.height === g.SH) blit(fb, 1);
  if (sN) LAST_BLIMB.set(world, sN);
  ctx.restore();
  return drew;
}

/** One idle slice of prebuilding the limb sprites a descent will need. Returns true when all are ready. */
export function prewarmBodyLimb(ctx, view, world, altsKm = [], light = SUN, horizonFrac = 0.62) {
  if (world === 'earth') return true;
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const g = blimbGeom(ctx, W, H, H * horizonFrac);
  const lb = lightBucket(light), L3 = blimbL3(lb);
  for (const a of altsKm) {
    const b = nearestBucket(Math.max(BLIMB_ALTS[0], a));
    const key = blimbKey(world, b, g, lb);
    if (ready(key)) continue;
    progressive(key, g.SW, g.SH, () => bodyLimbRows(world, b, g.SW, g.SH, g.rowHor, L3, g.F), { idle: true, chunk: 4 });
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ sky

const EARTH_SKY = [ // altKm, zenith, mid, horizon
  [0, '#3a78b8', '#6d9fcc', '#b8d2e4'],
  [5, '#2f69ab', '#5c92c6', '#a6c8e2'],
  [12, '#1d4f92', '#3f7bbd', '#86b2dc'],
  [25, '#0d2c62', '#245ca4', '#5c95d0'],
  [45, '#040f2c', '#0f3474', '#3570b6'],
  [70, '#01040e', '#061638', '#1a4688'],
  [110, '#000000', '#01040c', '#0a2048'],
  [400, '#000000', '#000000', '#020814'],
];
function skyAt(table, alt) {
  let i = 1; while (i < table.length - 1 && table[i][0] < alt) i++;
  const a = table[i - 1], b = table[i], t = clamp((alt - a[0]) / (b[0] - a[0] || 1), 0, 1);
  return [mixc(a[1], b[1], t), mixc(a[2], b[2], t), mixc(a[3], b[3], t)];
}

/** Sky colours for a world at altitude. */
export function skyColors(world, altKm, { sunElev = 0.5, weather = null } = {}) {
  void sunElev;
  const alt = Math.max(0, num(altKm));
  if (world === 'earth') {
    let [z, m, h] = skyAt(EARTH_SKY, alt);
    const risk = num(weather?.risk, 0);
    const over = alt < 12 ? sstep(35, 85, risk) * (1 - alt / 12) * 0.75 : 0;
    if (over > 0) { z = mixc(z, '#5b6773', over); m = mixc(m, '#7c8792', over); h = mixc(h, '#a3abb2', over); }
    return {
      zenith: cssOf(z), mid: cssOf(m), horizon: cssOf(h),
      haze: `rgba(217,227,234,${(0.38 * (1 - sstep(0, 25, alt))).toFixed(3)})`,
      starAlpha: sstep(38, 95, alt),
    };
  }
  const look = bodyLook(world);
  if (look.sky) {
    const k = sstep(0, world === 'titan' ? 300 : 60, alt);
    const z = mixc(look.sky[0], '#000000', k), h = mixc(look.sky[1], world === 'titan' ? '#3a2410' : '#05070f', k);
    return { zenith: cssOf(z), mid: cssOf(mixc(z, h, 0.55)), horizon: cssOf(h), haze: rgba(look.sky[1], 0.25 * (1 - k)), starAlpha: world === 'titan' ? 0 : k };
  }
  return { zenith: '#000000', mid: '#000000', horizon: '#020308', haze: 'rgba(0,0,0,0)', starAlpha: 1 };
}

/** The sun in black space: a small white disc with a tight bloom (no wide haze). */
function drawSunDisc(ctx, x, y, k = 1) {
  if (!(k > 0.01)) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, 30);
  g.addColorStop(0, `rgba(255,252,240,${(0.9 * k).toFixed(3)})`);
  g.addColorStop(0.16, `rgba(255,246,226,${(0.55 * k).toFixed(3)})`);
  g.addColorStop(0.4, `rgba(255,236,200,${(0.08 * k).toFixed(3)})`);
  g.addColorStop(1, 'rgba(255,236,200,0)');
  ctx.fillStyle = g; ctx.fillRect(x - 30, y - 30, 60, 60);
  ctx.fillStyle = `rgba(255,255,252,${k.toFixed(3)})`;
  ctx.beginPath(); ctx.arc(x, y, 3.2, 0, TAU); ctx.fill();
  ctx.restore();
}

/** Full-screen sky: gradient, horizon haze and a soft sun glare (opts.light). */
export function drawSky(ctx, view, world, altKm, opts = {}) {
  tick();
  if (world === 'earth') ensureWorld();
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const s = skyColors(world, altKm, opts);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, s.zenith); g.addColorStop(0.55, s.mid || s.zenith); g.addColorStop(1, s.horizon);
  ctx.fillStyle = g;
  ctx.fillRect(-40, -40, W + 80, H + 80);
  const alt = Math.max(0, num(altKm));
  const light = opts.light || (world === 'earth' && alt < 1 ? { ax: -0.95, ay: -0.31 } : SUN);
  const atmo = world === 'earth' || bodyLook(world).sky;
  if (atmo) {
    // sun glare: warm and wide at low altitude, tight and white in thin air
    const sx = W * (0.5 + num(light.ax) * 0.62), sy = H * (0.42 + num(light.ay) * 0.5);
    const thin = world === 'earth' ? sstep(10, 80, alt) : sstep(0, 40, alt);
    const rad = Math.max(W, H) * lerp(0.75, 0.3, thin);
    const warm = world === 'mars' ? [190, 205, 230] : world === 'titan' ? [255, 200, 120] : [255, 236, 200];
    const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
    const ov = opts.weather && num(opts.weather.risk) > 60 ? 0.4 : 1;
    // the scattering glare only exists in air: it fades out above ~35 km (no grey smudge on black space)
    const airK = world === 'earth' ? 1 - sstep(30, 65, alt) : 1 - sstep(25, 60, alt);
    if (airK > 0.01) {
      gl.addColorStop(0, `rgba(${warm[0]},${warm[1]},${warm[2]},${(0.42 * ov * (1 - thin * 0.4) * airK).toFixed(3)})`);
      gl.addColorStop(0.25, `rgba(${warm[0]},${warm[1]},${warm[2]},${(0.14 * ov * airK).toFixed(3)})`);
      gl.addColorStop(1, `rgba(${warm[0]},${warm[1]},${warm[2]},0)`);
      ctx.fillStyle = gl; ctx.fillRect(-40, -40, W + 80, H + 80);
    }
    if (airK < 0.99) drawSunDisc(ctx, sx, sy, 1 - airK);
  } else drawSunDisc(ctx, W * (0.5 + num(light.ax) * 0.62), H * (0.42 + num(light.ay) * 0.5), 1);
  return s;
}

/** Cached starfield (two layers + Milky Way band) scrolled horizontally by drift (px). */
export function drawStarfield(ctx, view, { alpha = 1, drift = 0, t = 0, seed = 1, reduce = false } = {}) {
  tick();
  alpha = num(alpha);
  if (!(alpha > 0.003)) return;
  void t; void reduce;
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const dpr = devScale(ctx);
  const S = 512;
  // real night-sky statistics: a few bright stars, many faint ones; colour temperature only lightly tinted;
  // almost every star is a single device pixel (no bloom), only the brightest ~1 % get a small soft halo
  const starTile = (key, n, sd) => cached(`stars2|${key}|${sd}|${dpr}`, S * dpr, S * dpr, (c) => {
    const R = rng(sd);
    const temps = [[214, 224, 255], [228, 234, 255], [246, 247, 255], [255, 250, 244], [255, 240, 222], [255, 230, 206]];
    for (let i = 0; i < n; i++) {
      const m = Math.pow(R(), 5);
      const tc = temps[Math.min(5, Math.floor(Math.pow(R(), 1.2) * 6))];
      const x = Math.floor(R() * S * dpr), y = Math.floor(R() * S * dpr);
      const a = 0.16 + 0.84 * m;
      if (m > 0.82) {
        const r = (0.8 + (m - 0.82) * 4) * dpr;
        const gr = c.createRadialGradient(x + 0.5, y + 0.5, 0, x + 0.5, y + 0.5, r * 1.7);
        gr.addColorStop(0, `rgba(${tc[0]},${tc[1]},${tc[2]},${a.toFixed(3)})`); gr.addColorStop(0.35, `rgba(${tc[0]},${tc[1]},${tc[2]},${(a * 0.25).toFixed(3)})`); gr.addColorStop(1, `rgba(${tc[0]},${tc[1]},${tc[2]},0)`);
        c.fillStyle = gr; c.fillRect(x - r * 2, y - r * 2, r * 4 + 1, r * 4 + 1);
      } else {
        c.fillStyle = `rgba(${tc[0]},${tc[1]},${tc[2]},${a.toFixed(3)})`;
        c.fillRect(x, y, 1, 1); // one device pixel
      }
    }
  });
  const far = starTile('far', 380, seed), near = starTile('near', 48, seed + 77);
  const band = lazy(`milky|${seed}`, 256, 128, (c, w, h) => {
    const img = c.createImageData(w, h), d = img.data;
    for (let j = 0; j < h; j++) {
      const yy = (j / h - 0.5) * 2;
      for (let i = 0; i < w; i++) {
        const u = i / w;
        const core = Math.exp(-(yy * yy) / 0.16) * (0.6 + 0.4 * Math.exp(-((u - 0.55) ** 2) / 0.05));
        const n = pfbm(u * 6, j / h * 3, 6, 3, 5, seed + 3) * 0.5 + 0.5;
        const dust = sstep(0.45, 0.7, pfbm(u * 10, j / h * 5 + 7, 10, 5, 4, seed + 4) * 0.5 + 0.5) * Math.exp(-((yy + 0.05) ** 2) / 0.03);
        const v = clamp(core * (0.4 + n * 0.8) - dust * 0.55, 0, 1);
        const o = (j * w + i) * 4;
        d[o] = 225 + 30 * (1 - u); d[o + 1] = 215; d[o + 2] = 200 + 40 * u; d[o + 3] = v * 70;
      }
    }
    c.putImageData(img, 0, 0);
  });
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  if (band) {
    ctx.save();
    ctx.translate(W * 0.5 - (num(drift) * 0.5) % 40, H * 0.4);
    ctx.rotate(-0.95);
    ctx.globalAlpha = Math.min(1, alpha) * Math.min(1, alpha) * 0.22; // the Milky Way needs a dark-adapted exposure
    ctx.drawImage(band, -H * 0.9, -W * 0.38, H * 1.8, W * 0.76);
    ctx.restore();
  }
  const tileLayer = (spr, par, off) => {
    if (!spr) return;
    const ox = -((((num(drift) * par + off) % S) + S) % S);
    for (let x = ox; x < W; x += S) for (let y = -(off % S); y < H; y += S) ctx.drawImage(spr, x, y, S, S);
  };
  ctx.globalAlpha = Math.min(1, alpha);
  tileLayer(far, 0.6, 0);
  tileLayer(near, 1, 211);
  ctx.restore();
}

// ------------------------------------------------------------------ clouds

/**
 * Cumulus sprite: union of seeded gaussian puffs with a flat base + fBm erosion; shaded by marching toward
 * the sun through the density field (self-shadowing) and darkened toward the base. kind: 'cu' | 'ci' | 'st'.
 */
function cloudSprite(kind, variant, lb) {
  const W = kind === 'ci' ? 384 : 320, H = kind === 'ci' ? 84 : kind === 'st' ? 130 : 186;
  return lazy(`cloud3|${kind}|${variant}|${lb}`, W, H, (c) => {
    const R = rng(hash(`cloud${kind}${variant}`));
    const D = new Float32Array(W * H);
    const L = bucketLight(lb);
    const sd = variant * 13 + (kind === 'ci' ? 500 : kind === 'st' ? 900 : 1);
    if (kind === 'cu') {
      // cauliflower cumulus: big base puffs, smaller turrets on the upper surface, flat condensation base
      const base = H * 0.84, puffs = [];
      const nBig = 5 + Math.floor(R() * 3);
      for (let i = 0; i < nBig; i++) { const px = W * (0.16 + (i + R() * 0.8) / nBig * 0.68), pr = H * (0.12 + R() * 0.08) * (1 - Math.abs(px / W - 0.5) * 1.1); puffs.push([px, base - pr * 0.7, pr]); }
      for (let i = 0; i < 4; i++) { const px = W * (0.36 + R() * 0.28), pr = H * (0.13 + R() * 0.08); puffs.push([px, base - pr * (1.4 + R() * 0.9), pr]); }
      for (let i = 0; i < 22; i++) { const p = puffs[Math.floor(R() * puffs.length)], a = -Math.PI * (0.1 + R() * 0.8); const pr = p[2] * (0.3 + R() * 0.35); puffs.push([p[0] + Math.cos(a) * p[2] * 0.85, Math.min(base - pr * 0.5, p[1] + Math.sin(a) * p[2] * 0.85), pr]); }
      const G = 2, gw = W / G, gh = H / G, coarse = new Float32Array(gw * gh), coarseN = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        let d = 0; const X = x * G, Y = y * G;
        for (const p of puffs) { const dx = (X - p[0]) / p[2], dy = (Y - p[1]) / p[2]; const q = dx * dx + dy * dy; if (q < 4) d = Math.max(d, 1 - q * 0.42) + Math.max(0, 0.25 - q * 0.1); }
        coarse[y * gw + x] = d;
        coarseN[y * gw + x] = pfbm(X / 60, Y / 60, 64, 64, 3, sd + 7); // low-frequency term: coarse grid is enough
      }
      const bnCol = new Float32Array(W); // base raggedness depends on x only: one evaluation per column
      for (let x = 0; x < W; x++) bnCol[x] = pfbm(x / 26, 0.5, 32, 1, 3, sd + 11) * 16 + pfbm(x / 7, 0.5, 64, 1, 2, sd + 12) * 5;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const d0 = sample1(coarse, gw, gh, x / G + 0.5, y / G + 0.5);
        const bil = 1 - Math.abs(pfbm(x / 22, y / 22, 64, 64, 4, sd));
        const n2 = sample1(coarseN, gw, gh, x / G + 0.5, y / G + 0.5);
        const edge = sstep(0, 0.12, x / W) * sstep(1, 0.88, x / W) * sstep(0, 0.1, y / H);
        const bn = bnCol[x]; // ragged, slightly lumpy base
        const ero = pfbm(x / 9, y / 9, 64, 64, 3, sd + 17); // fine erosion: wispy, fraying margins
        D[y * W + x] = (d0 + (bil - 0.6) * 0.6 + n2 * 0.22 + ero * 0.22 * (1 - Math.min(1, d0))) * sstep(base + 12 + bn, base - 12 + bn, y) * edge;
      }
    } else if (kind === 'ci') {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const env = Math.pow(Math.sin((x / W) * Math.PI), 0.8) * Math.exp(-(((y / H) - 0.5) ** 2) / 0.05);
        const warp = pfbm(x / 96, y / 48, 64, 64, 3, sd + 2) * 10;
        const fib = pfbm(x / 160, (y + warp) / 5, 64, 64, 4, sd + 3) * 0.5 + 0.5;
        const n = pfbm(x / 70, y / 30, 64, 64, 3, sd + 4) * 0.5 + 0.5;
        D[y * W + x] = env * sstep(0.35, 0.85, fib * 0.7 + n * 0.5);
      }
    } else {
      const puffs = [];
      const nP = 26 + Math.floor(R() * 10);
      for (let i = 0; i < nP; i++) {
        const gx = (R() + R() + R()) / 3; // centre-weighted
        const px = W * (0.06 + gx * 0.88), pr = H * (0.1 + R() * 0.16) * (1 - Math.abs(gx - 0.5) * 0.9);
        puffs.push([px, H * (0.62 - R() * 0.22) - pr * 0.3, pr]);
      }
      const G = 2, gw = W / G, gh = H / G, coarse = new Float32Array(gw * gh), coarseN = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        let d = 0; const X = x * G, Y = y * G;
        for (const p of puffs) { const dx = (X - p[0]) / p[2], dy = (Y - p[1]) / (p[2] * 0.8); const q = dx * dx + dy * dy; if (q < 5) d += Math.exp(-q * 1.5) * 0.55; }
        coarse[y * gw + x] = d;
        coarseN[y * gw + x] = pfbm(X / 70, Y / 50, 16, 16, 3, sd + 10);
      }
      const base = H * 0.74;
      const bnCol = new Float32Array(W);
      for (let x = 0; x < W; x++) bnCol[x] = pfbm(x / 30, 0.5, 32, 1, 3, sd + 13) * 13 + pfbm(x / 8, 0.5, 64, 1, 2, sd + 14) * 4;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const d0 = sample1(coarse, gw, gh, x / G + 0.5, y / G + 0.5);
        const bil = 1 - Math.abs(pfbm(x / 30, y / 24, 32, 32, 4, sd + 9));
        const n2 = sample1(coarseN, gw, gh, x / G + 0.5, y / G + 0.5);
        const bn = bnCol[x];
        const edge = sstep(0, 0.1, x / W) * sstep(1, 0.9, x / W) * sstep(0, 0.12, y / H);
        const ero = pfbm(x / 8, y / 8, 64, 64, 3, sd + 19);
        D[y * W + x] = (d0 + (bil - 0.55) * 0.5 + n2 * 0.22 + ero * 0.25 * (1 - Math.min(1, d0))) * sstep(base + 10 + bn, base - 10 + bn, y) * edge;
      }
    }
    const img = c.createImageData(W, H), d = img.data;
    const ln = Math.hypot(L.ax, L.ay) || 1, sx = (L.ax / ln) * 3, sy = (L.ay / ln) * 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, den = D[k];
      const al = kind === 'cu' ? sstep(0.3, 0.7, den) * (0.75 + 0.25 * sstep(0.55, 0.8, den)) : kind === 'ci' ? clamp(den * 0.85, 0, 0.75) : sstep(0.22, 0.66, den) * (0.7 + 0.22 * sstep(0.5, 0.8, den));
      if (al <= 0.004) continue;
      let occ = 0;
      for (let s = 1; s <= 8; s++) { const xx = Math.round(x + sx * s * s * 0.5), yy = Math.round(y + sy * s * s * 0.5); if (xx >= 0 && yy >= 0 && xx < W && yy < H) occ += Math.max(0, D[yy * W + xx] - 0.35); else break; }
      const T = Math.exp(-occ * (kind === 'ci' ? 0.3 : 1.5));
      let lum = 0.36 + 0.68 * T;
      if (kind === 'st') { lum = 0.34 + 0.72 * T; lum *= lerp(0.62, 1, sstep(H * 0.76, H * 0.36, y)); lum *= 0.9 + 0.15 * (pfbm(x / 16, y / 12, 32, 32, 2, sd + 29) * 0.5 + 0.5); }
      if (kind === 'cu') { // sunlit cauliflower tops, blue-grey shadowed core and base, billow-scale variation
        lum = 0.3 + 0.78 * T;
        lum *= lerp(0.55, 1, sstep(H * 0.86, H * 0.38, y));
        lum *= 0.9 + 0.16 * (pfbm(x / 14, y / 14, 64, 32, 2, sd + 23) * 0.5 + 0.5);
      }
      lum += (1 - sstep(0.42, 0.55, den)) * 0.12 * T; // silver lining at thin edges
      lum = clamp(lum, 0, 1.06);
      const o = k * 4;
      d[o] = clamp(lerp(112, 255, lum), 0, 255); d[o + 1] = clamp(lerp(126, 252, lum), 0, 255); d[o + 2] = clamp(lerp(152, 247, lum), 0, 255); d[o + 3] = al * 255;
    }
    c.putImageData(img, 0, 0);
  });
}

const CLOUD_DECKS = [
  { alt: 1.6, spread: 0.9, kind: 'cu', n: 9, size: 1.9 },
  { alt: 5.5, spread: 0.8, kind: 'st', n: 9, size: 2.2 },
  { alt: 10, spread: 1.2, kind: 'ci', n: 6, size: 6 },
];

/** Cloud decks at real altitudes (screen y = anchorY - (deckAlt - altKm) * pxPerKm). */
export function drawClouds(ctx, view, { altKm = 0, pxPerKm = 150, anchorY, drift = 0, t = 0, coverage = 0.4, world = 'earth', light = SUN } = {}) {
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const alt = Math.max(0, num(altKm)), ppk = Math.max(1, num(pxPerKm, 150)), ay = num(anchorY, H * 0.6);
  coverage = clamp(num(coverage, 0.4), 0, 1);
  if (world === 'titan' || world === 'venus') {
    // stacked haze sheets
    for (let i = 0; i < 6; i++) {
      const y = ay - ((i + 1) * 12 - alt) * ppk * 0.25;
      if (y < -60 || y > H + 60) continue;
      const g = ctx.createLinearGradient(0, y - 40, 0, y + 40);
      const c = world === 'titan' ? '220,160,80' : '240,225,180';
      g.addColorStop(0, `rgba(${c},0)`); g.addColorStop(0.5, `rgba(${c},0.25)`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.fillRect(-40, y - 40, W + 80, 80);
    }
    return;
  }
  if (world !== 'earth') return;
  const lb = lightBucket(light);
  const grey = sstep(0.55, 0.95, coverage);
  ctx.save();
  for (const deck of CLOUD_DECKS) {
    const n = Math.round(deck.n * (0.35 + coverage * 1.1));
    const R = rng(hash('deck|' + deck.alt));
    const wrap = W * 2.2;
    for (let i = 0; i < n; i++) {
      const dAlt = (R() - 0.5) * deck.spread, depth = 0.55 + R() * 0.9, x0 = R() * wrap, v = Math.floor(R() * 4), sz = deck.size * (0.6 + R() * 0.8);
      const y = ay - (deck.alt + dAlt - alt) * ppk;
      const spr = cloudSprite(deck.kind, v, lb);
      if (!spr) continue;
      const wpx = sz * ppk * 0.55 * depth, hpx = wpx * (spr.height / spr.width) * (deck.kind === 'cu' ? 1 : 0.8);
      if (y - hpx > H + 20 || y < -40) continue;
      const par = deck.kind === 'ci' ? 0.4 : 0.8 * depth;
      const x = ((((x0 - num(drift) * par - num(t) * 1.5 * depth) % wrap) + wrap) % wrap) - wpx * 0.5 - W * 0.4;
      ctx.globalAlpha = (deck.kind === 'ci' ? 0.75 : 0.95) * (0.55 + 0.45 * depth) * (1 - grey * 0.15);
      if (R() < 0.5) { ctx.save(); ctx.translate(x + wpx, 0); ctx.scale(-1, 1); ctx.drawImage(spr, 0, y - hpx, wpx, hpx); ctx.restore(); }
      else ctx.drawImage(spr, x, y - hpx, wpx, hpx);
    }
  }
  ctx.restore();
}

/**
 * Foreground pass while the vehicle crosses a cloud deck: big out-of-focus puffs sweeping past in front of
 * the vehicle and a white veil (inside the cloud the whole frame washes out), fading in and out across the
 * layer thickness. Call after the vehicle is drawn.
 */
export function drawCloudsFront(ctx, view, { altKm = 0, pxPerKm = 150, anchorY, t = 0, coverage = 0.4, light = SUN, reduce = false } = {}) {
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const alt = Math.max(0, num(altKm)), ppk = Math.max(1, num(pxPerKm, 150)), ay = num(anchorY, H * 0.6);
  coverage = clamp(num(coverage, 0.4), 0, 1);
  const lb = lightBucket(light);
  ctx.save();
  for (const deck of CLOUD_DECKS) {
    if (deck.kind === 'ci') continue;
    const half = deck.spread * 0.5 + 0.15, dAlt = alt - deck.alt;
    if (Math.abs(dAlt) > half) continue;
    const inside = 1 - sstep(half * 0.35, half, Math.abs(dAlt));
    const veil = inside * (0.25 + 0.5 * coverage);
    if (veil > 0.01) { ctx.globalAlpha = veil; ctx.fillStyle = '#eef2f5'; ctx.fillRect(-40, -40, W + 80, H + 80); }
    // near puffs: a few large sprites crossing the frame at the deck level, moving down as the vehicle climbs
    const R = rng(hash('front|' + deck.alt));
    for (let i = 0; i < 4; i++) {
      const off = (R() - 0.5) * deck.spread, xs = R(), v = Math.floor(R() * 4);
      const y = ay - (deck.alt + off - alt) * ppk * 2.2;
      const spr = cloudSprite(deck.kind, v, lb);
      if (!spr) continue;
      const wpx = W * (0.9 + R() * 0.8), hpx = wpx * (spr.height / spr.width);
      if (y - hpx > H || y < -hpx) continue;
      const x = xs * W - wpx / 2 - (reduce ? 0 : num(t) * 4) % W;
      ctx.globalAlpha = 0.85 * (0.4 + 0.6 * inside) * (0.5 + 0.5 * coverage);
      ctx.drawImage(spr, x, y - hpx * 0.6, wpx, hpx);
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------ perspective ground plane (shared by pads + landing)

/**
 * Ground-plane geometry for a camera hc metres above flat ground looking horizontally (focal f px):
 * screen row y (below the horizon hor) shows ground at depth Z = f·hc/(y−hor) metres with lateral scale
 * s = (y−hor)/hc px/m and foreshortening φ = (y−hor)/f.
 */
function planeAt(hor, hc, f, y) { const dy = Math.max(0.35, y - hor); return { s: dy / hc, Z: (f * hc) / dy, phi: dy / f }; }

/**
 * Fills the ground between rows y0..y1 with perspective-mapped tiles. layers: [{ key, tile (canvas),
 * tileM (metres per tile), mode: 'base'|'overlay'|'multiply', alpha }]. Base layers are opaque; overlay
 * layers (grey-centred detail) fade in when their texels approach screen resolution.
 */
function groundPlane(ctx, W, hor, y0, y1, hc, f, Xoff, Zoff, layers) {
  const prep = [];
  for (const ly of layers) {
    if (!ly.tile) continue;
    const mips = mipsOf(ly.key, ly.tile, 6);
    prep.push({ ...ly, mips, tp0: ly.tile.width / ly.tileM });
  }
  if (!prep.length) return false;
  y0 = Math.max(y0, hor + 0.4);
  const q = devScale(ctx);
  const snap = (v) => Math.round(v * q) / q;
  ctx.save();
  let y = y0;
  let guard = 0;
  while (y < y1 && guard++ < 400) {
    const bh = clamp((y - hor) * 0.075, 0.8, 16);
    const ya = y, yb = Math.min(y1, Math.max(ya + 1 / q, snap(y + bh)));
    const yc = (ya + yb) * 0.5;
    const s = (yc - hor) / hc;
    const Za = (f * hc) / Math.max(0.2, ya - hor), Zb = (f * hc) / Math.max(0.2, yb - hor);
    for (const ly of prep) {
      let alpha = ly.alpha ?? 1;
      const m = s / ly.tp0; // screen px per level-0 texel
      if (ly.mode !== 'base') {
        alpha *= sstep(1 / 96, 1 / 10, m) * (ly.fadeFar != null ? 1 : 1);
        if (ly.maxM) alpha *= 1 - sstep(ly.maxM, ly.maxM * 3, m);
        if (alpha < 0.02) continue;
      }
      const lvl = clamp(Math.floor(Math.log2(Math.max(1, 1 / Math.max(1e-6, m)))), 0, ly.mips.length - 1);
      const tex = ly.mips[lvl];
      const tp = tex.width / ly.tileM;
      const pat = patternOf(ctx, ly.key + '|' + lvl, tex);
      if (!pat) continue;
      const Sz = tex.height;
      let va = (Za + Zoff) * tp, vb = (Zb + Zoff) * tp;
      const sh = Math.floor(vb / Sz) * Sz; va -= sh; vb -= sh;
      const dv = va - vb;
      if (!(Math.abs(dv) > 1e-6)) continue;
      const d = (yb - ya) / (vb - va);
      const xw = tex.width / tp;
      const xo = ((Xoff % xw) + xw) % xw;
      if (!setPatternMatrix(pat, s / tp, 0, 0, d, W / 2 - xo * s, ya - va * d)) continue;
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = ly.mode === 'base' ? 'source-over' : ly.mode;
      ctx.fillStyle = pat;
      ctx.fillRect(-4, ya, W + 8, yb - ya);
    }
    y = yb;
  }
  ctx.restore();
  return true;
}

// ------------------------------------------------------------------ ground tiles (seamless, lit, cached)

/** Periodic crater stamp on a tile heightfield (pixel units). */
function tileCrater(Hf, A, S, cx, cy, r, depth, { fresh = 0, R } = {}) {
  const ext = r * 2.4, x0 = Math.floor(cx - ext), x1 = Math.ceil(cx + ext), y0 = Math.floor(cy - ext), y1 = Math.ceil(cy + ext);
  for (let yy = y0; yy <= y1; yy++) {
    const j = ((yy % S) + S) % S;
    for (let xx = x0; xx <= x1; xx++) {
      const i = ((xx % S) + S) % S, k = j * S + i;
      const d = Math.hypot(xx - cx, yy - cy) / r;
      if (d > 2.4) continue;
      let dh = d < 1 ? (d * d - 1) * depth + 0.2 * depth : 0.2 * depth * Math.pow(d, -3);
      dh += 0.14 * depth * Math.exp(-((d - 1) ** 2) / 0.015);
      Hf[k] += dh;
      if (fresh && A) A[k] += (d < 1.6 ? 0.12 : 0.04) * fresh * (1 - sstep(1, 2.4, d));
    }
  }
  void R;
}

/** Gaussian bump (rock/pebble) on a periodic heightfield. */
function tileBump(Hf, S, cx, cy, r, hgt) {
  const ext = r * 2, x0 = Math.floor(cx - ext), x1 = Math.ceil(cx + ext), y0 = Math.floor(cy - ext), y1 = Math.ceil(cy + ext);
  for (let yy = y0; yy <= y1; yy++) {
    const j = ((yy % S) + S) % S;
    for (let xx = x0; xx <= x1; xx++) {
      const i = ((xx % S) + S) % S, d2 = ((xx - cx) ** 2 + (yy - cy) ** 2) / (r * r);
      if (d2 < 4) Hf[j * S + i] += hgt * Math.exp(-d2 * 1.8);
    }
  }
}

/**
 * Shades a heightfield into RGBA. Light: screen light → ground frame (x right, up, z away). Cast shadows by
 * marching toward the sun. colorFn(k, a, out) gives the albedo colour (0..255) when overlay=false; overlay
 * tiles are grey-centred (128 = no change) so they only modulate the base layer.
 */
function shadeTile(c, S, Hf, A, lb, { overlay = false, colorFn = null, relief = 1, shadows = true, ambient = 0.12, gloss = 0 } = {}) {
  const L0 = bucketLight(lb);
  let lx = L0.ax, ly = Math.max(0.12, -L0.ay), lz = 0.35;
  const ln = Math.hypot(lx, ly, lz); lx /= ln; ly /= ln; lz /= ln;
  const flat = ly;
  const img = c.createImageData(S, S), d = img.data;
  const tanE = ly / Math.max(0.05, Math.hypot(lx, lz));
  const stepX = lx / Math.max(1e-3, Math.hypot(lx, lz)), stepZ = lz / Math.max(1e-3, Math.hypot(lx, lz));
  const out = [0, 0, 0];
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const k = j * S + i;
      const hx = (Hf[j * S + (i + 1) % S] - Hf[j * S + (i - 1 + S) % S]) * 0.5 * relief;
      const hz = (Hf[((j + 1) % S) * S + i] - Hf[((j - 1 + S) % S) * S + i]) * 0.5 * relief;
      const nl = Math.hypot(hx, 1, hz);
      let dif = (-hx * lx + ly - hz * lz) / nl;
      dif = Math.max(0, dif);
      let sh = 1;
      if (shadows) {
        const h0 = Hf[k] * relief;
        for (let st = 1; st <= 24; st += st < 6 ? 1 : 3) {
          const xi = Math.round(i + stepX * st), zj = Math.round(j + stepZ * st);
          const hh = Hf[((zj % S) + S) % S * S + ((xi % S) + S) % S] * relief;
          if (hh > h0 + st * tanE) { sh = 0; break; }
        }
      }
      let lum = (ambient + (1 - ambient) * dif * (sh ? 1 : 0.0)) / (ambient + (1 - ambient) * flat);
      if (gloss) lum += gloss * Math.pow(dif, 12) * sh;
      const o = k * 4;
      if (overlay) {
        const v = clamp(128 * (1 + (lum - 1) * 0.62) * (A ? 1 + A[k] : 1), 0, 255);
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
      } else {
        colorFn(k, A ? A[k] : 0, out);
        d[o] = clamp(out[0] * lum, 0, 255); d[o + 1] = clamp(out[1] * lum, 0, 255); d[o + 2] = clamp(out[2] * lum, 0, 255); d[o + 3] = 255;
      }
    }
  }
  c.putImageData(img, 0, 0);
}

/** Terrain family per world (landing ground look). */
function terrainFamily(world) {
  if (world === 'mars') return 'mars';
  if (world === 'titan') return 'titan';
  if (world === 'io') return 'io';
  if (['europa', 'enceladus', 'triton', 'pluto'].includes(world)) return 'ice';
  const look = bodyLook(world);
  if (look.kind === 'small' || world === 'phobos' || world === 'deimos') return 'rubble';
  return 'lunar';
}

/** Seamless ground tile for a landing world. level: 'mega' (colour, km scale) | 'macro' | 'fine' (overlay). */
function terrainTile(world, level, lb) {
  const fam = terrainFamily(world);
  const S = 256;
  return (level === 'mega' ? cached : lazy)(`ttile|${world}|${level}|${lb}`, S, S, (c) => {
    const look = bodyLook(world);
    const seed = hash(world + level), R = rng(seed);
    const Hf = new Float32Array(S * S), A = new Float32Array(S * S);
    const P = S / 64; // periodic noise period in lattice cells at base frequency
    const nCr = { mega: 26, macro: 60, fine: 45 }[level];
    const crR = { mega: [3, 46], macro: [3, fam === 'lunar' ? 22 : 40], fine: [2.5, 26] }[level]; // lunar macro: no big crescent shadows (they smear into dark ribbons in perspective)
    const craterK = fam === 'lunar' ? 1 : fam === 'rubble' ? 0.7 : fam === 'mars' ? 0.45 : fam === 'ice' ? 0.25 : fam === 'io' ? 0.08 : 0.06;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i, u = i / 64, v = j / 64;
      const n = pfbm(u, v, P, P, 5, seed), n2 = pfbm(u * 4, v * 4, P * 4, P * 4, 3, seed + 3);
      // broad relief stays low on the macro overlay: cast shadows of a smooth fbm height field read as dark
      // meandering swaths ("painted rivers") once stretched by the perspective; craters carry the relief instead
      Hf[k] = n * (level !== 'fine' && fam !== 'mars' ? 1.6 : 6) + n2 * 1.2;
      A[k] = n * 0.18 + n2 * 0.08;
      if (fam === 'mars' && level !== 'mega') { // aeolian ripples
        const rip = Math.sin((i + pfbm(u, v, P, P, 3, seed + 5) * 30) * (TAU / (level === 'fine' ? 22 : 14)));
        Hf[k] += rip * (level === 'fine' ? 0.7 : 1.2);
      }
      if (fam === 'titan') { const dune = Math.sin((i * 0.7 + j * 0.15 + n * 40) * (TAU / 48)); Hf[k] += dune * (level === 'mega' ? 3 : 0.6); A[k] -= level === 'mega' ? Math.max(0, dune) * 0.15 : 0; }
      if (fam === 'ice') { const cr = pfbm(u * 2, v * 2, P * 2, P * 2, 4, seed + 9); const line = 1 - sstep(0.0, 0.03, Math.abs(cr)); Hf[k] += line * 2.5; A[k] -= line * (level === 'mega' ? 0.25 : 0.08); }
      if (fam === 'io') { A[k] += sstep(0.1, 0.3, n) * 0.3 - sstep(-0.3, -0.45, n) * 0.4; Hf[k] *= 0.4; }
    }
    const dens = (x, y) => 0.5 + 0.5 * pfbm(x / 64, y / 64, P, P, 2, seed + 21); // 0..1 crater-density mask
    const want = Math.round(nCr * craterK * (level === 'mega' ? 0.7 : 2.6));
    for (let i = 0, tries = 0; i < want && tries < want * 6; tries++) {
      const r = crR[0] * Math.pow(crR[1] / crR[0], Math.pow(R(), level === 'mega' ? 3.6 : 4.2)); // steep power law: many small, few large
      const cx = R() * S, cy = R() * S;
      if (R() > Math.pow(sstep(0.25, 0.8, dens(cx, cy)), 1.5) * 0.95 + 0.05) continue;
      i++;
      // fresh (bright-rimmed) craters only small ones; mega-scale craters are old, degraded and shallow
      tileCrater(Hf, A, S, cx, cy, r, r * (fam === 'mars' ? 0.35 : level === 'mega' ? 0.22 : 0.55), { fresh: level !== 'mega' && r < crR[1] * 0.3 && R() < 0.12 ? 1 : 0 });
    }
    if (level === 'fine') { // pebbles + regolith grain
      const nPeb = fam === 'rubble' ? 320 : fam === 'titan' ? 190 : fam === 'mars' ? 150 : fam === 'ice' ? 45 : 95;
      for (let i = 0; i < nPeb; i++) { const r = 0.9 + Math.pow(R(), 3) * (fam === 'rubble' ? 5 : 3); tileBump(Hf, S, R() * S, R() * S, r, r * (fam === 'titan' ? 0.9 : 1.3)); }
      for (let k = 0; k < S * S; k++) A[k] += (lattice(k % S, (k / S) | 0, seed) - 0.5) * 0.12;
    }
    if (level === 'macro' && (fam === 'rubble' || fam === 'mars')) {
      for (let i = 0; i < (fam === 'rubble' ? 260 : 90); i++) { const r = 1.5 + Math.pow(R(), 3) * 6; tileBump(Hf, S, R() * S, R() * S, r, r * 1.2); }
    }
    const shadows = fam !== 'titan';
    const ambient = fam === 'titan' ? 0.55 : fam === 'mars' ? 0.28 : fam === 'ice' ? 0.12 : 0.06;
    if (level === 'mega') {
      const pal = mkRamp(look.palette.map((cc, i) => [i / (look.palette.length - 1), cc]));
      const mid = fam === 'lunar' ? 0.55 : fam === 'ice' ? 0.82 : 0.5;
      const AL = new Float32Array(S * S);
      const lunarAL = fam === 'lunar' || fam === 'rubble';
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        if (!lunarAL) { AL[j * S + i] = pfbm(i / 128, j / 128, S / 128, S / 128, 4, seed + 31); continue; }
        // mare / highland albedo: a few broad, lobate patches (2 smooth octaves, domain-warped) plus fine mottling;
        // no thin thresholded bands (those read as painted rivers once the tile is seen in perspective)
        const wx = pfbm(i / 64, j / 64, S / 64, S / 64, 2, seed + 41) * 26, wy = pfbm(i / 64 + 3.1, j / 64, S / 64, S / 64, 2, seed + 43) * 26;
        const big = pfbm((i + wx) / 256, (j + wy) / 256, S / 256, S / 256, 2, seed + 31, 0.35);
        const mot = pfbm(i / 32, j / 32, S / 32, S / 32, 3, seed + 47);
        AL[j * S + i] = -sstep(0.08, 0.22, big) * 0.13 + mot * 0.035 + sstep(-0.3, -0.42, big) * 0.05;
      }
      shadeTile(c, S, Hf, A, lb, { relief: 0.2, shadows: shadows && !lunarAL, ambient: Math.max(ambient, 0.25), colorFn: (k, a, out) => ramp(pal, clamp(mid + a * 1.1 + (lunarAL ? AL[k] : AL[k] * 0.16), 0, 1), out) });
    } else {
      shadeTile(c, S, Hf, A, lb, { overlay: true, relief: level === 'fine' ? 0.55 : 0.6, shadows, ambient, gloss: fam === 'ice' ? 0.4 : 0 });
    }
  });
}

/** Grey-centred detail tile used to sharpen big planet discs (shared with drawPlanetDisc). */
function detailTile(id, level, lb) {
  if (id === 'earthcloud') {
    return lazy(`dtile|earthcloud|${lb}`, 256, 256, (c, S) => {
      const img = c.createImageData(S, S), d = img.data;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const v = 128 + pfbm(i / 32, j / 32, 8, 8, 4, 5) * 60; const o = (j * S + i) * 4; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; }
      c.putImageData(img, 0, 0);
    });
  }
  const fam = terrainFamily(id);
  return lazy(`dtile|${id}|${lb}`, 256, 256, (c, S) => {
    const seed = hash(id + 'disc'), R = rng(seed);
    const Hf = new Float32Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) Hf[j * S + i] = pfbm(i / 64, j / 64, 4, 4, 5, seed) * 3;
    const n = fam === 'lunar' || fam === 'rubble' ? 70 : fam === 'mars' ? 30 : 12;
    for (let i = 0; i < n; i++) { const r = 2 + Math.pow(R(), 3) * 16; tileCrater(Hf, null, S, R() * S, R() * S, r, r * 0.35); }
    shadeTile(c, S, Hf, null, lb, { overlay: true, relief: 0.5, shadows: false, ambient: 0.3 });
  });
}

// ------------------------------------------------------------------ silhouettes: distant ridges, tree lines

/**
 * Horizontally seamless ridge strip (1024×128 px). kind: 'lunar' | 'mesa' | 'dunes' | 'ice' | 'hills' |
 * 'mountains' | 'jungle' | 'cliffs'. Lit by the screen light; haze (0..1) blends toward hazeColor.
 */
function ridgeStrip(kind, colors, lb, seed, haze = 0, hazeColor = '#000000') {
  const W = 1024, H = 128;
  return lazy(`ridge|${kind}|${colors.join(',')}|${lb}|${seed}|${haze.toFixed(2)}|${hazeColor}`, W, H, (c) => {
    const L0 = bucketLight(lb);
    const prof = new Float32Array(W);
    const apronH = new Float32Array(W); // mesa: height where the caprock cliff meets its talus apron
    for (let x = 0; x < W; x++) {
      const u = x / 128;
      let h;
      const per = (cells, oct, sd, gain = 0.5) => pfbm((x / W) * cells, 0.5, cells, 1, oct, sd, gain);
      if (kind === 'mesa') {
        // eroded buttes: a ragged caprock (notched, slightly domed top), a steep cliff band, then a concave talus
        // apron spreading out to the plain; heights vary from butte to butte
        const n = per(5, 4, seed) * 0.5 + 0.5 + per(23, 2, seed + 5) * 0.035;
        const P = 0.55 + 0.4 * (per(3, 2, seed + 9) * 0.5 + 0.5);
        const apron = Math.pow(sstep(0.36, 0.5, n), 1.8);
        const cliff = sstep(0.495, 0.512, n);
        const cap = cliff * (0.03 * per(64, 3, seed + 1) + 0.025 * sstep(0.52, 0.7, n) - 0.04 * Math.pow(Math.max(0, per(31, 2, seed + 3)), 3));
        const upper = sstep(0.6, 0.63, n) * 0.12 * P; // a second, smaller tier on the biggest buttes
        h = 0.07 + P * (0.42 * apron + 0.43 * cliff) + cap + upper + per(90, 2, seed + 2) * 0.008;
        apronH[x] = 0.07 + P * 0.42 * apron;
      } else if (kind === 'dunes') {
        h = 0.2 + 0.22 * Math.pow(0.5 + 0.5 * Math.sin((x / W) * TAU * 9 + per(4, 2, seed) * 3), 1.6) + per(16, 3, seed + 2) * 0.06;
      } else if (kind === 'ice') {
        h = 0.12 + Math.pow(clamp(1 - Math.abs(per(8, 5, seed) * 2.4), 0, 1), 2.5) * 0.6 + per(32, 2, seed + 1) * 0.04;
      } else if (kind === 'mountains') {
        const env = per(2, 3, seed + 3) * 0.5 + 0.5;
        h = 0.08 + Math.pow(clamp(1 - Math.abs(per(5, 5, seed) * 2.2), 0, 1), 1.6) * (0.35 + 0.5 * env) + per(24, 3, seed + 4) * 0.04;
      } else if (kind === 'jungle' || kind === 'hills') {
        h = 0.25 + (per(4, 4, seed) * 0.5 + 0.5) * 0.55;
      } else if (kind === 'cliffs') {
        h = 0.3 + (per(4, 4, seed) * 0.5 + 0.5) * 0.4;
      } else { // lunar massifs: smooth, rounded
        const n = per(4, 4, seed, 0.42);
        h = 0.12 + sstep(-0.45, 0.65, n) * 0.85;
      }
      prof[x] = clamp(h, 0.04, 0.98);
    }
    const img = c.createImageData(W, H), d = img.data;
    const C = colors.map(rgbOf), HZ = rgbOf(hazeColor);
    // surface relief noise for the face (stretched horizontally: erosion gullies / strata)
    const NZ = new Float32Array(W * H);
    const sy = kind === 'mesa' ? 6 : 3;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) NZ[y * W + x] = pfbm(x / 32, y / (sy === 6 ? 48 : 28), 32, 64, 4, seed + 7);
    let lx = L0.ax, ly = L0.ay, lz = 0.4; const ln = Math.hypot(lx, ly, lz); lx /= ln; ly /= ln; lz /= ln;
    const amb = haze > 0.05 ? 0.32 : 0.05;
    const jungle = kind === 'jungle';
    for (let x = 0; x < W; x++) {
      const top = H * (1 - prof[x]);
      const slope = (prof[(x + 2) % W] - prof[(x - 2 + W) % W]) * H * 0.25;
      for (let y = Math.max(0, Math.floor(top)); y < H; y++) {
        const k = y * W + x, o = k * 4;
        const depthIn = (y - top) / Math.max(8, H - top);
        const gnx = (NZ[y * W + (x + 1) % W] - NZ[y * W + (x - 1 + W) % W]) * (jungle ? 14 : 5);
        const gny = (NZ[Math.min(H - 1, y + 1) * W + x] - NZ[Math.max(0, y - 1) * W + x]) * (jungle ? 14 : 5);
        let nx = slope * 1.4 + gnx, ny = -(0.75 - 0.6 * depthIn) + gny, nz = 1;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const dif = Math.max(0, nx * lx + ny * ly + nz * lz);
        let lum = amb + (1 - amb) * dif * 1.25;
        if (kind === 'mesa') {
          const yr = H - y; // height above the strip base (px)
          if (yr > apronH[x] * H + 1) { // cliff face: thin sedimentary beds, gently warped, stronger on the caprock
            const bed = Math.sin(yr * 0.9 + NZ[k] * 5 + x * 0.004) * 0.5 + 0.5;
            const capK = sstep(top + 1, top + 5, y) * (1 - sstep(top + 5, top + 9, y));
            lum *= 0.9 + 0.09 * bed - 0.1 * capK + 0.06 * NZ[k];
          } else { // talus: downslope streaks of debris, darker toward the foot
            const st = pfbm(x / 4, y / 32, 256, 4, 2, seed + 11) * 0.5 + 0.5;
            lum *= 0.86 + 0.16 * st + 0.08 * (1 - depthIn);
          }
        }
        const t2 = clamp(lum, 0, 1.4);
        let cr, cg, cb;
        if (t2 < 0.7) { const q = t2 / 0.7; cr = lerp(C[0][0] * 0.35, C[0][0], q); cg = lerp(C[0][1] * 0.35, C[0][1], q); cb = lerp(C[0][2] * 0.35, C[0][2], q); }
        else { const q = clamp((t2 - 0.7) / 0.6, 0, 1), C2 = C[2] || C[1]; cr = lerp(C[1][0], C2[0], q * q) * (0.85 + q * 0.15); cg = lerp(C[1][1], C2[1], q * q) * (0.85 + q * 0.15); cb = lerp(C[1][2], C2[2], q * q) * (0.85 + q * 0.15); if (t2 < 0.85) { const r = (t2 - 0.7) / 0.15; cr = lerp(C[0][0], cr, r); cg = lerp(C[0][1], cg, r); cb = lerp(C[0][2], cb, r); } }
        const hzk = haze * (0.8 + 0.2 * (1 - depthIn));
        cr = lerp(cr, HZ[0], hzk); cg = lerp(cg, HZ[1], hzk); cb = lerp(cb, HZ[2], hzk);
        const aa = clamp(y + 1 - top, 0, 1) * (1 - sstep(0.72, 1, y / H));
        d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = 255 * aa;
      }
    }
    c.putImageData(img, 0, 0);
  });
}

/** Draws a seamless strip at depth Z (m): base on the ground at Z, height heightM, scrolled by Xoff (m). */
function drawStripAtDepth(ctx, W, strip, hor, hc, f, Z, spanM, heightM, Xoff, { fadeBottom = 0.3, alpha = 1 } = {}) {
  if (!strip) return;
  const s = f / Z, base = hor + hc * s;
  const w = spanM * s, h = heightM * s;
  if (w < 2 || base - h > 99999) return;
  const off = (((Xoff * s) % w) + w) % w;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let x = W / 2 - off - Math.ceil((W / 2) / w + 1) * w; x < W + w; x += w) ctx.drawImage(strip, x, base - h, w + 0.5, h + 1);
  ctx.restore();
  void fadeBottom;
  return base;
}

/** Tree-line / vegetation strip (seamless 512×96): 'palm' | 'scrub' | 'jungle' | 'conifer' | 'grass'. */
function vegStrip(kind, lb, tint = null) {
  const W = 512, H = 96;
  return lazy(`veg|${kind}|${lb}|${tint || ''}`, W, H, (c) => {
    const R = rng(hash('veg' + kind));
    const L0 = bucketLight(lb);
    const base = tint ? rgbOf(tint) : kind === 'conifer' ? [38, 52, 36] : kind === 'jungle' ? [44, 74, 36] : kind === 'scrub' ? [84, 92, 56] : kind === 'grass' ? [120, 118, 70] : [62, 82, 44];
    const shade = (k) => `rgb(${Math.round(base[0] * k)},${Math.round(base[1] * k)},${Math.round(base[2] * k)})`;
    const blob = (x, y, r, k) => {
      for (const dx of [-W, 0, W]) {
        const g = c.createRadialGradient(x + dx + L0.ax * r * 0.4, y + L0.ay * r * 0.4, r * 0.1, x + dx, y, r);
        g.addColorStop(0, shade(k * 1.25)); g.addColorStop(0.7, shade(k)); g.addColorStop(1, shade(k * 0.7));
        c.fillStyle = g; c.beginPath(); c.arc(x + dx, y, r, 0, TAU); c.fill();
      }
    };
    if (kind === 'palm') {
      for (let i = 0; i < 60; i++) blob(R() * W, H - 6 - R() * 10, 5 + R() * 9, 0.6 + R() * 0.3);
      for (let i = 0; i < 26; i++) {
        const x = R() * W, h = 40 + R() * 46, lean = (R() - 0.5) * 10;
        for (const dx of [-W, 0, W]) {
          c.strokeStyle = 'rgb(86,72,52)'; c.lineWidth = 1.6; c.beginPath(); c.moveTo(x + dx, H); c.quadraticCurveTo(x + dx + lean * 0.3, H - h * 0.5, x + dx + lean, H - h); c.stroke();
          for (let f = 0; f < 8; f++) {
            const a = (f / 8) * TAU + R() * 0.4, len = 9 + R() * 7;
            c.strokeStyle = shade(0.75 + 0.35 * Math.max(0, -Math.cos(a - Math.atan2(L0.ay, L0.ax))));
            c.lineWidth = 2.2; c.beginPath(); c.moveTo(x + dx + lean, H - h);
            c.quadraticCurveTo(x + dx + lean + Math.cos(a) * len * 0.6, H - h + Math.sin(a) * len * 0.3 - 4, x + dx + lean + Math.cos(a) * len, H - h + Math.abs(Math.sin(a)) * len * 0.6 + 2);
            c.stroke();
          }
        }
      }
    } else if (kind === 'conifer') {
      for (let i = 0; i < 140; i++) {
        const x = R() * W, h = 30 + R() * 60, w = h * (0.22 + R() * 0.08);
        for (const dx of [-W, 0, W]) {
          const g = c.createLinearGradient(x + dx - w, 0, x + dx + w, 0);
          g.addColorStop(0, shade(L0.ax < 0 ? 1.15 : 0.6)); g.addColorStop(1, shade(L0.ax < 0 ? 0.6 : 1.15));
          c.fillStyle = g; c.beginPath(); c.moveTo(x + dx, H - h);
          for (let k = 0; k <= 6; k++) { const yy = H - h + (h * k) / 6; c.lineTo(x + dx + w * (k / 6) * (k % 2 ? 1 : 0.8), yy); }
          c.lineTo(x + dx - w, H); for (let k = 6; k >= 0; k--) c.lineTo(x + dx - w * (k / 6) * (k % 2 ? 1 : 0.8), H - h + (h * k) / 6);
          c.fill();
        }
      }
    } else if (kind === 'jungle') {
      for (let i = 0; i < 220; i++) blob(R() * W, H - 10 - Math.pow(R(), 0.6) * 62, 6 + R() * 14, 0.55 + R() * 0.45);
    } else if (kind === 'grass') {
      for (let i = 0; i < 160; i++) blob(R() * W, H - 3 - R() * 5, 2 + R() * 5, 0.6 + R() * 0.4);
    } else {
      for (let i = 0; i < 180; i++) blob(R() * W, H - 4 - Math.pow(R(), 1.5) * 26, 3 + R() * 8, 0.55 + R() * 0.45);
    }
    // ground contact shade
    const g = c.createLinearGradient(0, H - 10, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
    c.fillStyle = g; c.fillRect(0, H - 10, W, 10);
  });
}

// ------------------------------------------------------------------ boulders

/** Lit boulder sprite (96×72, base at the bottom). family-specific shape/colour. */
function rockSprite(world, v, lb) {
  return lazy(`rock|${world}|${v}|${lb}`, 96, 72, (c, W, H) => {
    const fam = terrainFamily(world), look = bodyLook(world);
    const seed = hash(world + 'rock' + v);
    const L0 = bucketLight(lb);
    const pal = look.palette.map(rgbOf);
    const dark = pal[Math.max(0, Math.floor(pal.length * 0.25))], light = pal[Math.min(pal.length - 1, Math.floor(pal.length * 0.75))];
    const rx = W * 0.44, ry = H * (0.62 + lattice(v, 1, seed) * 0.3);
    const round = fam === 'titan' ? 1 : fam === 'ice' ? 0.15 : fam === 'mars' ? 0.4 : 0.3;
    const img = c.createImageData(W, H), d = img.data;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = (i - W / 2) / rx, y = (H - 1 - j) / ry; // y up from base
      const th = Math.atan2(y, x);
      const rr = 1 + (pfbm(th * 1.3 + 7, 0.5, 9, 1, 4, seed) * (1 - round) * 0.55) + (round < 0.5 ? Math.abs(Math.sin(th * 3 + v)) * -0.12 : 0);
      const dist = Math.hypot(x, y) / rr;
      if (dist >= 1 || y < 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - dist * dist));
      let nx = x / rr, ny = -y / rr; // screen y down
      const fac = (1 - round) * 0.9;
      nx += pfbm(i / 9, j / 9, 11, 8, 3, seed + 1) * fac; ny += pfbm(i / 9 + 5, j / 9, 11, 8, 3, seed + 2) * fac;
      const nl = Math.hypot(nx, ny, nz);
      const lit = Math.max(0, (nx * L0.ax + ny * L0.ay + nz * 0.45) / nl);
      const amb = fam === 'titan' ? 0.45 : fam === 'mars' ? 0.18 : 0.04;
      const k = amb + (1 - amb) * lit;
      const tex = 0.85 + (lattice(i, j, seed) - 0.5) * 0.25 + pfbm(i / 6, j / 6, 16, 12, 2, seed + 4) * 0.15;
      const o = (j * W + i) * 4;
      const base = mixc(dark, light, clamp(k * 1.1, 0, 1));
      const edge = clamp((1 - dist) * 18, 0, 1);
      const contact = sstep(0.0, 0.12, y);
      d[o] = clamp(base[0] * k * 1.25 * tex * (0.55 + 0.45 * contact), 0, 255);
      d[o + 1] = clamp(base[1] * k * 1.25 * tex * (0.55 + 0.45 * contact), 0, 255);
      d[o + 2] = clamp(base[2] * k * 1.25 * tex * (0.55 + 0.45 * contact), 0, 255);
      d[o + 3] = 255 * edge;
    }
    c.putImageData(img, 0, 0);
  });
}

const ROCK_BUF = { n: 0, z: new Float32Array(900), x: new Float32Array(900), r: new Float32Array(900), v: new Uint8Array(900), idx: new Uint16Array(900) };

/** Scatters boulders on the ground plane from a seeded world-space grid (stable while scrolling). */
function drawRocks(ctx, W, H, hor, hc, f, Xoff, world, lb, seed, light, density = 1, horizonCurve = 0) {
  const fam = terrainFamily(world);
  const classes = fam === 'rubble' ? [[0.25, 1.6, 0.5], [0.8, 4, 0.35], [2.4, 12, 0.25], [6, 30, 0.15]] : fam === 'titan' ? [[0.12, 1, 0.5], [0.4, 3, 0.25]] : fam === 'ice' ? [[0.3, 4, 0.2], [1, 10, 0.12]] : fam === 'mars' ? [[0.15, 1.2, 0.45], [0.45, 3.6, 0.3], [1.3, 10, 0.12]] : [[0.15, 1.6, 0.3], [0.5, 4.5, 0.18], [1.6, 14, 0.08]];
  const buf = ROCK_BUF;
  buf.n = 0;
  const yBot = H + 30;
  const Zmin = (f * hc) / Math.max(1, yBot - hor);
  for (let ci = 0; ci < classes.length; ci++) {
    const [rM, cell, p] = classes[ci];
    const Zmax = Math.min((f * rM) / 1.1, Zmin + 4000);
    const z0 = Math.floor(Zmin / cell), z1 = Math.ceil(Zmax / cell);
    if (z1 - z0 > 260) continue;
    for (let zi = z0; zi <= z1; zi++) {
      const Z = zi * cell;
      if (Z < Zmin * 0.8) continue;
      if ((rM * f) / Z < 0.9 || buf.n >= 600) break;
      const halfW = (W / 2 + 40) * Z / f;
      const x0 = Math.floor((Xoff - halfW) / cell), x1 = Math.ceil((Xoff + halfW) / cell);
      if (x1 - x0 > 160) continue;
      for (let xi = x0; xi <= x1; xi++) {
        const hsh = h32(xi, zi, ci, seed);
        if ((hsh & 1023) / 1024 > p * density) continue;
        if (buf.n >= 600) break;
        const k = buf.n++;
        buf.z[k] = Z + ((hsh >>> 10) & 255) / 256 * cell;
        buf.x[k] = (xi + ((hsh >>> 18) & 255) / 256) * cell;
        buf.r[k] = rM * (0.5 + ((hsh >>> 4) & 63) / 63);
        buf.v[k] = (hsh >>> 26) & 3;
      }
    }
  }
  const n = buf.n;
  for (let i = 0; i < n; i++) buf.idx[i] = i;
  const idx = buf.idx.subarray(0, n);
  idx.sort((a, b) => buf.z[b] - buf.z[a]);
  const L0 = light || SUN;
  const elev = Math.max(0.12, -num(L0.ay, -0.6));
  const shLen = 1 / Math.tan(Math.asin(clamp(elev, 0.1, 0.99))) * 0.9;
  const shDir = -Math.sign(num(L0.ax, -1)) || 1;
  const airless = !bodyLook(world).atmosphere;
  const shA = airless ? 0.82 : fam === 'titan' ? 0.25 : 0.5;
  ctx.save();
  for (let q = 0; q < n; q++) {
    const k = idx[q];
    const Z = buf.z[k], s = f / Z;
    const x = W / 2 + (buf.x[k] - Xoff) * s;
    let y = hor + hc * s;
    if (horizonCurve) y += horizonCurve * (x - W / 2) * (x - W / 2);
    const rp = buf.r[k] * s;
    if (rp < 1.1 || x < -rp * 4 || x > W + rp * 4 || y > H + rp) continue;
    const phi = (y - hor) / f;
    const fadeIn = sstep(1.1, 2.6, rp);
    // cast shadow on the ground (foreshortened)
    // cast shadow: starts under the rock and stretches away from the sun along the ground (the rock covers its
    // root), umbra a darkened floor colour at ~0.85, never a detached black hole
    ctx.globalAlpha = Math.min(0.85, shA) * fadeIn * (rp < 3 ? 0.6 : 1);
    ctx.fillStyle = airless ? 'rgb(16,15,14)' : 'rgb(46,26,16)';
    const sl = rp * (0.7 + shLen * 0.45);
    ctx.beginPath();
    ctx.ellipse(x + shDir * (sl - rp * 0.55), y - Math.max(0.3, rp * phi * 0.2), sl, Math.max(0.5, rp * phi * 0.9 + 0.3), 0, 0, TAU);
    ctx.fill();
    if (rp > 2.5) { // contact shade right at the base
      ctx.globalAlpha = 0.22 * fadeIn;
      ctx.beginPath(); ctx.ellipse(x, y, rp * 0.95, Math.max(0.6, rp * phi * 0.6 + 0.3), 0, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = fadeIn;
    const spr = rockSprite(world, buf.v[k], lb);
    if (spr) {
      const ar = 0.55 + ((buf.v[k] * 37 + k) % 7) / 14; // varied aspect: flat slabs to rounded blocks
      const w = rp * 2.2, h = w * (spr.height / spr.width) * 0.8 * ar;
      ctx.drawImage(spr, x - w / 2, y - h + Math.max(0.5, h * 0.12), w, h);
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------ landing terrain

const TERRAIN_RIDGES = {
  lunar: { far: 'lunar', mid: 'lunar', farH: 1800, midH: 120 },
  mars: { far: 'mesa', mid: 'dunes', farH: 1100, midH: 60 },
  titan: { far: 'dunes', mid: 'dunes', farH: 300, midH: 40 },
  ice: { far: 'ice', mid: 'ice', farH: 700, midH: 60 },
  io: { far: 'mountains', mid: 'lunar', farH: 2500, midH: 80 },
  rubble: null,
};

/** Parallax landing terrain for `world`; groundY = screen y of the touchdown point. */
const TERR = { sig: '', n: 0, c: null, csig: '' };
/**
 * Parallax landing terrain. Once the camera stops moving (hover, touchdown, landed) the finished picture is kept in
 * an offscreen canvas and blitted, so a static shot costs one drawImage instead of ~100 pattern bands.
 */
export function drawTerrain(ctx, view, world, opts = {}) {
  const W = num(view?.W, 375), H = num(view?.H, 700);
  if (world === 'earth' || typeof document === 'undefined') return drawTerrainRaw(ctx, view, world, opts);
  const dpr = devScale(ctx);
  const sig = [world, W, H, dpr, Math.round(num(opts.groundY) * 2), Math.round(num(opts.pxPerM, 4) * 500), Math.round(num(opts.scrollX) * 2), lightBucket(opts.light || SUN), opts.seed].join('|');
  if (TERR.c && TERR.csig === sig) { ctx.drawImage(TERR.c, 0, 0, W, H); return; }
  if (sig !== TERR.sig) { TERR.sig = sig; TERR.n = 0; }
  if (++TERR.n < 12) return drawTerrainRaw(ctx, view, world, opts);
  const c = TERR.c && TERR.c.width === Math.round(W * dpr) && TERR.c.height === Math.round(H * dpr) ? TERR.c : makeCanvas(W * dpr, H * dpr);
  const g = c && c.getContext('2d');
  if (!g) return drawTerrainRaw(ctx, view, world, opts);
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTerrainRaw(g, view, world, opts);
  TERR.c = c; TERR.csig = sig;
  ctx.drawImage(c, 0, 0, W, H);
}

function drawTerrainRaw(ctx, view, world, { altM = 0, pxPerM = 4, groundY, scrollX = 0, t = 0, seed = 1, light = SUN } = {}) {
  tick();
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const ppm = Math.max(0.05, num(pxPerM, 4));
  const gy = num(groundY, H * 0.8);
  const alt = Math.max(0, num(altM));
  const lb = lightBucket(light);
  const hor = Math.min(gy - H * 0.05, H * 0.62);
  const f = H;
  const hcGeo = Math.max(0.5, (gy - hor) / ppm);
  const hc = lerp(hcGeo, Math.max(hcGeo, alt * 0.5), sstep(H * 0.95, H * 1.35, gy));
  const Xoff = num(scrollX) / ppm;
  if (world === 'earth') return drawOcean(ctx, W, H, hor, hc, f, Xoff, num(t), lb, light);
  const look = bodyLook(world);
  const fam = terrainFamily(world);
  const sky = skyColors(world, alt / 1000);
  const atmo = !!look.sky;
  const small = fam === 'rubble';
  const curve = small ? 0.9 / W : 0;
  ctx.save();
  if (curve) { // tiny body: the horizon visibly curves away
    ctx.beginPath(); ctx.moveTo(-10, H + 10);
    for (let x = -10; x <= W + 10; x += 12) ctx.lineTo(x, hor + curve * (x - W / 2) ** 2);
    ctx.lineTo(W + 10, H + 10); ctx.closePath(); ctx.clip();
  }
  // base fill under everything (covers band gaps at the horizon)
  const pal = look.palette;
  ctx.fillStyle = pal[Math.floor(pal.length / 2)];
  ctx.fillRect(-10, hor, W + 20, H - hor + 10);
  const layers = [
    { key: `ttile|${world}|mega|${lb}`, tile: terrainTile(world, 'mega', lb), tileM: small ? 600 : 7000, mode: 'base' },
    { key: `ttile|${world}|macro|${lb}`, tile: terrainTile(world, 'macro', lb), tileM: small ? 40 : 320, mode: 'overlay', alpha: 0.62 },
    { key: `ttile|${world}|macro|${lb}`, tile: terrainTile(world, 'macro', lb), tileM: small ? 97 : 1130, mode: 'overlay', alpha: 0.38 },
    { key: `ttile|${world}|fine|${lb}`, tile: terrainTile(world, 'fine', lb), tileM: small ? 5 : 10, mode: 'overlay', alpha: 0.95 },
    { key: `ttile|${world}|fine|${lb}`, tile: terrainTile(world, 'fine', lb), tileM: 2.2, mode: 'overlay', alpha: 0.6 },
  ];
  if (!groundPlane(ctx, W, hor, hor, H + 2, hc, f, Xoff, 0, layers)) {
    const g = ctx.createLinearGradient(0, hor, 0, H);
    g.addColorStop(0, pal[1] || pal[0]); g.addColorStop(1, pal[Math.min(2, pal.length - 1)]);
    ctx.fillStyle = g; ctx.fillRect(-10, hor, W + 20, H - hor + 10);
  }
  // distant ridges (parallax by depth), then aerial haze
  const rd = TERRAIN_RIDGES[fam];
  if (rd) {
    const C = [pal[0], pal[Math.min(pal.length - 1, 2)], pal[pal.length - 1]];
    const hzc = atmo ? cssToHex(skyColors(world, 0).horizon) : '#000000'; // fixed key: the strips must not rebuild as the sky darkens with altitude
    const far = ridgeStrip(rd.far, C, lb, hash(world + 'far'), atmo ? 0.55 : 0.0, hzc);
    const mid = ridgeStrip(rd.mid, C, lb, hash(world + 'mid'), atmo ? 0.25 : 0.0, hzc);
    drawStripAtDepth(ctx, W, far, hor, hc, f, 16000, 26000, rd.farH, Xoff);
    drawStripAtDepth(ctx, W, mid, hor, hc, f, 2200, 3200, rd.midH, Xoff);
  }
  if (atmo) {
    const g = ctx.createLinearGradient(0, hor - 2, 0, hor + (H - hor) * 0.45);
    g.addColorStop(0, rgba(cssToHex(sky.horizon), world === 'titan' ? 0.85 : 0.55)); g.addColorStop(1, rgba(cssToHex(sky.horizon), 0));
    ctx.fillStyle = g; ctx.fillRect(-10, hor - 2, W + 20, (H - hor) * 0.45 + 2);
  }
  if (!atmo) {
    const mc = rgbOf(pal[Math.floor(pal.length / 2)]);
    const g = ctx.createLinearGradient(0, hor, 0, hor + (H - hor) * 0.18);
    g.addColorStop(0, `rgba(${mc[0]},${mc[1]},${mc[2]},0.55)`); g.addColorStop(1, `rgba(${mc[0]},${mc[1]},${mc[2]},0)`);
    ctx.fillStyle = g; ctx.fillRect(-10, hor, W + 20, (H - hor) * 0.18);
  }
  drawRocks(ctx, W, H, hor, hc, f, Xoff, world, lb, num(seed, 1) >>> 0, light, small ? 1.4 : 1, curve);
  ctx.restore();
}

function cssToHex(css) {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(css));
  if (!m) return String(css).startsWith('#') ? css : '#000000';
  return '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
}

/** Splashdown ocean: perspective swell tiles drifting with time + Fresnel sky reflection. */
function drawOcean(ctx, W, H, hor, hc, f, Xoff, t, lb, light) {
  const base = cached(`ocean|base|${lb}`, 256, 256, (c, S) => {
    const Hf = new Float32Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const u = i / S, v = j / S;
      Hf[j * S + i] = Math.sin((u * 3 + v * 1) * TAU) * 3 + Math.sin((u * -2 + v * 4) * TAU) * 2 + Math.sin((u * 7 + v * 5) * TAU) * 0.8 + pfbm(u * 8, v * 8, 8, 8, 4, 41) * 2;
    }
    shadeTile(c, S, Hf, null, lb, { relief: 2.2, shadows: false, ambient: 0.4, gloss: 1.1, colorFn: (k, a, out) => { out[0] = 18; out[1] = 66; out[2] = 96; } });
  });
  const fine = cached(`ocean|fine|${lb}`, 256, 256, (c, S) => {
    const Hf = new Float32Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const u = i / S, v = j / S; Hf[j * S + i] = pfbm(u * 16, v * 16, 16, 16, 4, 42) * 3 + Math.sin((u * 9 + v * 3) * TAU) * 0.8; }
    shadeTile(c, S, Hf, null, lb, { overlay: true, relief: 1.1, shadows: false, ambient: 0.4, gloss: 0.9 });
  });
  ctx.save();
  ctx.fillStyle = '#123e5c'; ctx.fillRect(-10, hor, W + 20, H - hor + 10);
  groundPlane(ctx, W, hor, hor, H + 2, hc, f, Xoff + t * 0.8, t * 2.2, [
    { key: `ocean|base|${lb}`, tile: base, tileM: 60, mode: 'base' },
    { key: `ocean|fine|${lb}`, tile: fine, tileM: 6, mode: 'overlay', alpha: 1 },
    { key: `ocean|fine|${lb}`, tile: fine, tileM: 23, mode: 'overlay', alpha: 0.6 },
  ]);
  // Fresnel: grazing angles reflect the sky
  const g = ctx.createLinearGradient(0, hor, 0, H);
  g.addColorStop(0, 'rgba(178,204,224,0.8)'); g.addColorStop(0.06, 'rgba(150,186,214,0.35)'); g.addColorStop(0.35, 'rgba(120,160,200,0.08)'); g.addColorStop(1, 'rgba(120,160,200,0)');
  ctx.fillStyle = g; ctx.fillRect(-10, hor, W + 20, H - hor + 10);
  // sun glitter column toward the sun's azimuth
  const sx = W * (0.5 + num(light?.ax, -0.6) * 0.6);
  const gg = ctx.createRadialGradient(sx, hor + 4, 0, sx, hor + 4, W * 0.5);
  gg.addColorStop(0, 'rgba(255,248,230,0.12)'); gg.addColorStop(1, 'rgba(255,248,230,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(sx, hor + 2); ctx.scale(1, 0.22); ctx.translate(-sx, -(hor + 2));
  ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(sx, hor + 2, W * 0.28, 0, TAU); ctx.fill();
  ctx.restore();
}

/** Soft elliptical shadow under a craft at heightAboveM (foreshortened, offset away from the sun). */
export function drawGroundShadow(ctx, x, groundY, { widthPx = 30, heightAboveM = 0, pxPerM = 4, light = SUN, world = 'moon', objHeightM = 0, objWidthM = 0 } = {}) {
  x = num(x); groundY = num(groundY);
  const hM = Math.max(0, num(heightAboveM)), ppm = Math.max(0.05, num(pxPerM, 4));
  if (num(objHeightM) > 2.2 * Math.max(0.5, num(objWidthM, 1)) && world !== 'earth') { // tall craft: projected silhouette of an upright craft: a strip on the ground, away from the sun
    const Hc = num(objHeightM), Wc = Math.max(0.5, num(objWidthM, Hc * 0.3));
    const elev = clamp(-num(light?.ay, -0.6), 0.12, 0.99);
    const cot = Math.sqrt(1 - elev * elev) / elev;
    const dir = -Math.sign(num(light?.ax, -1)) || 1;
    const airless = !bodyLook(world).atmosphere;
    const a0 = (airless ? 0.86 : world === 'titan' ? 0.25 : 0.5) * (1 - sstep(Hc * 4 + 40, Hc * 8 + 160, hM));
    if (a0 > 0.01) {
      // the sun is behind-left of the camera: only ~half of the shadow's ground length shows as a sideways run,
      // the rest recedes toward the viewer (foreshortened); it always starts at the footpads when landed
      const side = 0.5;
      const x0 = x + dir * hM * cot * ppm * side, x1 = x + dir * (hM + Hc) * cot * ppm * side;
      const th = Math.max(1, Wc * ppm * 0.16), blur = airless ? 0 : th * 0.8 + hM * 0.02 * ppm;
      ctx.save();
      // the sun is a little behind the camera: the shadow runs away from the sun AND slightly toward the viewer,
      // so it lies on the ground in perspective (not along the horizon); umbra = darkened regolith, never #000
      const dy = (x1 - x0) * dir * 0.22;
      const strip = (grow, alpha) => {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        const t0 = th + grow, t1 = th * 0.45 + grow;
        ctx.moveTo(x0, groundY - t0); ctx.lineTo(x0 + (x1 - x0) * 0.7, groundY + dy * 0.7 - t1);
        ctx.quadraticCurveTo(x1, groundY + dy - t1 * 0.6, x1 + dir * grow, groundY + dy); ctx.quadraticCurveTo(x1, groundY + dy + t1 * 0.6, x0 + (x1 - x0) * 0.7, groundY + dy * 0.7 + t1);
        ctx.lineTo(x0, groundY + t0); ctx.closePath(); ctx.fill();
      };
      ctx.fillStyle = airless ? 'rgb(14,14,16)' : 'rgb(40,22,14)';
      strip(blur + Math.max(0.8, th * 0.5), a0 * 0.3); // soft penumbra
      strip(blur * 0.4, a0 * 0.85);
      // contact shade right under the footpads once close
      const near = 1 - sstep(0, 12, hM);
      if (near > 0) { ctx.globalAlpha = 0.55 * near; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(x, groundY + 0.5, Wc * ppm * 0.6, Math.max(1, th * 0.8), 0, 0, TAU); ctx.fill(); }
      ctx.restore();
    }
    return;
  }
  const fadeK = 1 - sstep(10, 90, hM);
  if (fadeK <= 0 || world === 'earth') return;
  const elev = Math.max(0.15, -num(light?.ay, -0.6));
  const offM = (hM + 1) / Math.tan(Math.asin(clamp(elev, 0.15, 0.99)));
  const dx = -Math.sign(num(light?.ax, -1)) * offM * ppm * 0.55;
  const w = Math.max(2, num(widthPx, 30)) * (1 + hM / 40);
  const hgt = Math.max(1.2, w * 0.16);
  const airless = !bodyLook(world).atmosphere;
  ctx.save();
  // offset away from the sun even on the ground (the shadow of the body, not just of the footpads)
  const dx0 = -Math.sign(num(light?.ax, -1)) * Math.max(0.6, num(objHeightM, 2) * 0.45) * ppm / Math.tan(Math.asin(clamp(elev, 0.15, 0.99)));
  ctx.translate(x + (hM < 30 ? lerp(dx0, dx, hM / 30) : dx), groundY + 1);
  const a = (world === 'titan' ? 0.3 : airless ? 0.78 : 0.55) * fadeK;
  if (airless && hM < 8) {
    ctx.fillStyle = 'rgb(12,12,14)';
    ctx.globalAlpha = a * 0.35; ctx.beginPath(); ctx.ellipse(0, 0, w * 0.62, hgt * 0.7, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = a * 0.85; ctx.beginPath(); ctx.ellipse(0, 0, w * 0.55, hgt * 0.55, 0, 0, TAU); ctx.fill();
  } else {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.6);
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(0.6, `rgba(0,0,0,${a * 0.75})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.scale(1, hgt / w); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, w * 0.6, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// ------------------------------------------------------------------ Earth ground + pad

export const SITE_STYLE = {
  canaveral: 'florida', wallops: 'florida', starbase: 'bocachica', vandenberg: 'coastal_hills',
  wenchang: 'wenchang', sriharikota: 'sriharikota', kourou: 'kourou', baikonur: 'steppe', plesetsk: 'taiga',
  vostochny: 'taiga', jiuquan: 'desert', taiyuan: 'desert', xichang: 'mountains', tanegashima: 'island',
  uchinoura: 'island', mahia: 'peninsula', naro: 'island', andoya: 'peninsula', alcantara: 'florida',
};
export function siteStyleOf(siteId) { return SITE_STYLE[siteId] || 'generic'; }

/**
 * Per-style scenery. ground: [dark, mid, light] albedo; accent: second ground material (sand/soil/marsh);
 * sea: water colour when a coastline is on the horizon (seaZ = shore distance, m); far/mid: ridge strips;
 * veg: tree-line strips [{ kind, Z, h }]; props: infrastructure.
 */
const SITES = {
  florida: { ground: ['#4b5636', '#6b7346', '#8c8c5c'], accent: '#b8ab84', marsh: '#3a5048', sea: '#2d6688', seaZ: 3200, veg: [{ kind: 'scrub', Z: 900, h: 6 }, { kind: 'palm', Z: 420, h: 16 }], props: 'florida' },
  bocachica: { ground: ['#8f8466', '#bca984', '#d8c8a2'], accent: '#7d7860', marsh: '#5a6a68', sea: '#3d7f98', seaZ: 1800, veg: [{ kind: 'grass', Z: 600, h: 3 }], props: 'bocachica' },
  coastal_hills: { ground: ['#8a7848', '#b39a5e', '#cdb67a'], accent: '#6a6a3e', sea: '#4f7f9a', seaZ: 5000, far: { kind: 'hills', Z: 9000, h: 500, colors: ['#6e6440', '#a89060', '#c8b07a'] }, veg: [{ kind: 'scrub', Z: 700, h: 5, tint: '#4a4a2e' }], props: 'generic', fog: true },
  wenchang: { ground: ['#3f6230', '#557a3a', '#7a9a52'], accent: '#9a5a3a', sea: '#2f7f9a', seaZ: 2500, veg: [{ kind: 'palm', Z: 700, h: 18 }, { kind: 'palm', Z: 350, h: 15 }], props: 'china' },
  sriharikota: { ground: ['#55603a', '#6e7a45', '#8f9460'], accent: '#c9b48a', sea: '#2f6f8a', seaZ: 3000, veg: [{ kind: 'scrub', Z: 800, h: 7 }, { kind: 'palm', Z: 500, h: 14 }], props: 'india' },
  kourou: { ground: ['#2e5224', '#3f6a2e', '#5e8a44'], accent: '#8a4a2a', far: { kind: 'jungle', Z: 7000, h: 260, colors: ['#22401e', '#3e6a32', '#5a8a46'] }, veg: [{ kind: 'jungle', Z: 1400, h: 30 }, { kind: 'jungle', Z: 650, h: 26 }], props: 'kourou', humid: true },
  steppe: { ground: ['#8f8058', '#b9a77a', '#d2c296'], accent: '#a49465', veg: [{ kind: 'grass', Z: 500, h: 2, tint: '#9a8a5a' }], props: 'baikonur' },
  taiga: { ground: ['#2e3826', '#3d4a32', '#5a6648'], accent: '#6a6a5a', veg: [{ kind: 'conifer', Z: 1600, h: 28 }, { kind: 'conifer', Z: 700, h: 26 }], props: 'generic', grey: true },
  desert: { ground: ['#8a7858', '#ae9a78', '#c8b896'], accent: '#7a6a52', far: { kind: 'mountains', Z: 40000, h: 2200, colors: ['#7a7a88', '#a8a4a8', '#c8c0bc'] }, veg: [], props: 'china' },
  mountains: { ground: ['#3c5430', '#4f6a3a', '#6c8650'], accent: '#7a6a4a', far: { kind: 'mountains', Z: 6000, h: 1100, colors: ['#33502a', '#5a7a46', '#86a06a'] }, veg: [{ kind: 'jungle', Z: 1200, h: 20, tint: '#3a5a2e' }], props: 'china', humid: true },
  island: { ground: ['#3f6230', '#557a3a', '#7a9a52'], accent: '#8a8a6a', sea: '#2f6f9a', seaZ: 2200, far: { kind: 'cliffs', Z: 5000, h: 160, colors: ['#3a5a2e', '#5a7a46', '#86a06a'] }, veg: [{ kind: 'jungle', Z: 800, h: 14 }], props: 'generic' },
  peninsula: { ground: ['#55703a', '#6a8a45', '#8aa860'], accent: '#7a7a5a', sea: '#2f6f9a', seaZ: 1500, veg: [{ kind: 'grass', Z: 600, h: 3 }], props: 'small' },
  generic: { ground: ['#4a5a36', '#5f6f45', '#7d8c5c'], accent: '#7a7a5a', veg: [{ kind: 'scrub', Z: 800, h: 6 }], props: 'generic' },
};

/** Raised pad / mount height (m) per tower type: the vehicle base sits this far above the surrounding ground. */
const MOUNT_H = { fss: 8, mechazilla: 20, ml: 14, gantry: 5, umbilical: 5, tulip: 4, none: 2 };

function siteGroundTile(style, level, lb) {
  const st = SITES[style] || SITES.generic;
  const S = 256;
  return (level === 'mega' ? cached : lazy)(`stile|${style}|${level}|${lb}`, S, S, (c) => {
    const seed = hash(style + level), Hf = new Float32Array(S * S), A = new Float32Array(S * S);
    const P = S / 64;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i, u = i / 64, v = j / 64;
      const n = pfbm(u, v, P, P, 5, seed), n2 = pfbm(u * 4, v * 4, P * 4, P * 4, 3, seed + 1);
      Hf[k] = (level === 'fine' ? n2 * 2.4 + (lattice(i, j, seed) - 0.5) * 1.6 : n * 2);
      A[k] = n * 0.5 + n2 * 0.2;
    }
    if (level === 'fine') {
      shadeTile(c, S, Hf, A, lb, { overlay: true, relief: 0.7, shadows: false, ambient: 0.35 });
    } else {
      const g = st.ground.map(rgbOf), acc = rgbOf(st.accent), marsh = st.marsh ? rgbOf(st.marsh) : null;
      shadeTile(c, S, Hf, A, lb, {
        relief: 0.4, shadows: false, ambient: 0.5, colorFn: (k, a, out) => {
          const t = clamp(0.5 + a * 1.4, 0, 1);
          const base = t < 0.5 ? mixc(g[0], g[1], t * 2) : mixc(g[1], g[2], (t - 0.5) * 2);
          const i = k % S, j = (k / S) | 0;
          const patch = sstep(0.18, 0.3, pfbm(i / 48, j / 48, S / 48, S / 48, 4, seed + 9));
          let c2 = mixc(base, acc, patch * 0.8);
          if (marsh) { const w = sstep(0.25, 0.32, pfbm(i / 40 + 3, j / 40, S / 40, S / 40, 4, seed + 11)); c2 = mixc(c2, marsh, w * 0.9); }
          out[0] = c2[0]; out[1] = c2[1]; out[2] = c2[2];
        },
      });
    }
  });
}

function concreteTile(lb) {
  return lazy(`concrete|${lb}`, 256, 256, (c, S) => {
    const Hf = new Float32Array(S * S), A = new Float32Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i;
      Hf[k] = (lattice(i, j, 5) - 0.5) * 0.6;
      const seam = (i % 64 < 1 || j % 64 < 1) ? -0.25 : 0;
      A[k] = pfbm(i / 32, j / 32, 8, 8, 4, 77) * 0.25 + seam + (lattice(i >> 6, j >> 6, 9) - 0.5) * 0.12;
    }
    shadeTile(c, S, Hf, A, lb, { relief: 1, shadows: false, ambient: 0.6, colorFn: (k, a, out) => { const v = 150 + a * 120; out[0] = v; out[1] = v * 0.985; out[2] = v * 0.95; } });
  });
}

// --- vector props (drawn at real scale at a ground depth Z, lateral X metres)

function projector(W, hor, hc, f, Xoff) {
  return (X, Z) => { const s = f / Z; return { x: W / 2 + (X - Xoff) * s, y: hor + hc * s, s }; };
}

/** Steel lattice tower face: two lit columns, girders and X-bracing. */
function lattice2D(ctx, x, yBase, wPx, hPx, bayPx, colLit, colDark, lw) {
  if (hPx < 2) return;
  const g = ctx.createLinearGradient(x, 0, x + wPx, 0);
  g.addColorStop(0, colLit); g.addColorStop(1, colDark);
  ctx.strokeStyle = g;
  ctx.lineWidth = Math.max(0.6, lw);
  ctx.beginPath();
  ctx.moveTo(x, yBase); ctx.lineTo(x, yBase - hPx);
  ctx.moveTo(x + wPx, yBase); ctx.lineTo(x + wPx, yBase - hPx);
  ctx.stroke();
  ctx.lineWidth = Math.max(0.4, lw * 0.55);
  ctx.beginPath();
  const bays = Math.max(1, Math.round(hPx / Math.max(2, bayPx)));
  const bh = hPx / bays;
  for (let b = 0; b <= bays; b++) {
    const y = yBase - b * bh;
    ctx.moveTo(x, y); ctx.lineTo(x + wPx, y);
    if (b < bays) { ctx.moveTo(x, y); ctx.lineTo(x + wPx, y - bh); ctx.moveTo(x + wPx, y); ctx.lineTo(x, y - bh); }
  }
  ctx.stroke();
}

function drawTowerType(ctx, P, Z0, tower, towerH, vR, towerArm, mountH, lb, t) {
  const L0 = bucketLight(lb);
  const lit = L0.ax < 0;
  const at = (X, Y) => { const p = P(X, Z0); return { x: p.x, y: p.y - Y * p.s, s: p.s }; };
  const s = P(0, Z0).s;
  const steel = ['#b8bcc0', '#5e6268'];
  const gy = (Y) => at(0, Y).y;
  if (tower === 'none') {
    const b = at(-vR - 1.4, 0);
    ctx.fillStyle = '#2b2d30'; ctx.fillRect(b.x - 0.8 * s, gy(towerH * 0.85), 1.6 * s, b.y - gy(towerH * 0.85));
    return;
  }
  if (tower === 'tulip') {
    // Soyuz launch system: the rocket hangs over the open flame pit in four support trusses ("tulip") that grip
    // the strap-on boosters' load points; they swing back (open like petals) at liftoff. Service masts retracted.
    const open = 1 - clamp(towerArm, 0, 1);
    const truss = (x0, y0, x1, y1, w, col) => { // lattice truss between two points (screen px), width w px
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, nx = -dy / l * w / 2, ny = dx / l * w / 2;
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(0.6, w * 0.16);
      ctx.beginPath(); ctx.moveTo(x0 + nx, y0 + ny); ctx.lineTo(x1 + nx * 0.6, y1 + ny * 0.6); ctx.moveTo(x0 - nx, y0 - ny); ctx.lineTo(x1 - nx * 0.6, y1 - ny * 0.6);
      const n = Math.max(2, Math.round(l / Math.max(3, w * 1.4)));
      for (let i = 0; i < n; i++) { const a0 = i / n, a1 = (i + 1) / n, sA = 1 - 0.4 * a0, sB = 1 - 0.4 * a1; ctx.moveTo(x0 + dx * a0 + nx * sA, y0 + dy * a0 + ny * sA); ctx.lineTo(x0 + dx * a1 - nx * sB, y0 + dy * a1 - ny * sB); }
      ctx.stroke();
    };
    for (const depth of [-1, 1]) for (const side of [-1, 1]) {
      const back = depth < 0;
      const piv = at(side * (vR + (back ? 3.2 : 4.4)), mountH - 0.5);
      const ang = side * open * 0.9;
      const reachX = side * (vR + (back ? 0.4 : 1.25)), reachY = mountH + 15.5;
      const tx = piv.x + ((reachX * s) - (piv.x - P(0, Z0).x)) * Math.cos(ang) - 0, ty0 = at(0, reachY).y;
      const L0 = Math.hypot(tx - piv.x, ty0 - piv.y);
      const a0 = Math.atan2(ty0 - piv.y, tx - piv.x) + ang;
      const ex = piv.x + Math.cos(a0) * L0, ey = piv.y + Math.sin(a0) * L0;
      truss(piv.x, piv.y, ex, ey, 1.6 * s, back ? (lit ? '#5d6064' : '#46494d') : (lit ? '#8e9296' : '#5c6064'));
      if (!back && open < 0.2) { ctx.fillStyle = '#3b3e42'; ctx.fillRect(ex - 0.6 * s, ey - 0.5 * s, 1.2 * s, 1 * s); } // bearing head on the load point
    }
    for (const side of [-1, 1]) { // retracted service/cable masts, well clear of the rocket
      const m = at(side * (vR + 16), 0);
      lattice2D(ctx, m.x - 1 * s, m.y, 2 * s, 28 * s, 2.4 * s, steel[0], steel[1], 0.22 * s);
    }
    return;
  }
  if (tower === 'mechazilla') {
    const tw = 12, tx = -(vR + 9) - tw, H = Math.max(towerH * 1.08, 140);
    const b = at(tx, 0), top = at(tx, H);
    ctx.fillStyle = 'rgba(30,32,35,0.55)'; ctx.fillRect(b.x, top.y, tw * s, b.y - top.y);
    lattice2D(ctx, b.x, b.y, tw * s, b.y - top.y, 9 * s, '#8a8e94', '#2e3034', 0.6 * s);
    lattice2D(ctx, b.x + 2 * s, b.y, (tw - 4) * s, b.y - top.y, 4.5 * s, 'rgba(120,124,130,0.6)', 'rgba(40,42,46,0.6)', 0.18 * s);
    // carriage + chopsticks at ~ 0.62 H, QD arm to the ship at ~0.6 of the stack
    const cy = gy(H * 0.62);
    ctx.fillStyle = '#3a3c40'; ctx.fillRect(b.x - 1 * s, cy - 5 * s, (tw + 2) * s, 7 * s);
    for (const dz of [-1, 1]) {
      ctx.fillStyle = dz < 0 ? '#5b5f64' : '#7d8186';
      ctx.beginPath(); ctx.moveTo(b.x + tw * s, cy - (dz < 0 ? 4 : 1.5) * s); ctx.lineTo(b.x + (tw + 30) * s, cy - (dz < 0 ? 3.2 : 0.8) * s); ctx.lineTo(b.x + (tw + 30) * s, cy - (dz < 0 ? 2.2 : -0.2) * s); ctx.lineTo(b.x + tw * s, cy + (dz < 0 ? -2 : 0.5) * s); ctx.fill();
    }
    const qy = gy(towerH / 1.05 * 0.62 + mountH);
    const reach = (vR + 9) * towerArm;
    ctx.fillStyle = '#4a4d52'; ctx.fillRect(b.x + tw * s, qy - 2.2 * s, reach * s, 3 * s);
    // crane top + lightning rod
    ctx.fillStyle = '#2e3034'; ctx.fillRect(b.x - 2 * s, top.y - 6 * s, (tw + 4) * s, 6 * s);
    ctx.fillRect(b.x + tw * s * 0.5 - 0.3 * s, top.y - 22 * s, 0.6 * s, 16 * s);
    return;
  }
  if (tower === 'gantry') {
    // enclosed mobile gantry rolled back + a slim umbilical mast beside the vehicle
    const gx = -(vR + 26), gw = 30, gh = towerH * 1.15;
    const b = at(gx - gw, 0), top = at(gx - gw, gh);
    const g = ctx.createLinearGradient(b.x, 0, b.x + gw * s, 0);
    g.addColorStop(0, lit ? '#e2e4e2' : '#9a9c9c'); g.addColorStop(0.85, lit ? '#b4b8b8' : '#d8dad8'); g.addColorStop(1, '#8a8e90');
    ctx.fillStyle = g; ctx.fillRect(b.x, top.y, gw * s, b.y - top.y);
    ctx.strokeStyle = 'rgba(80,86,92,0.35)'; ctx.lineWidth = Math.max(0.5, 0.25 * s);
    ctx.beginPath();
    for (let k = 1; k < 8; k++) { const x = b.x + (k / 8) * gw * s; ctx.moveTo(x, top.y); ctx.lineTo(x, b.y); }
    for (let y = top.y; y < b.y; y += 6 * s) { ctx.moveTo(b.x, y); ctx.lineTo(b.x + gw * s, y); }
    ctx.stroke();
    ctx.fillStyle = '#c8452f'; ctx.fillRect(b.x, top.y, gw * s, 2.5 * s);
    ctx.fillStyle = 'rgba(20,22,26,0.7)'; ctx.fillRect(b.x + gw * s * 0.3, b.y - gh * 0.75 * s, gw * s * 0.4, gh * 0.75 * s);
    tower = 'umbilical';
  }
  if (tower === 'umbilical' || tower === 'fss' || tower === 'ml') {
    const tw = tower === 'umbilical' ? 5 : tower === 'ml' ? 12 : 9;
    const tx = -(vR + (tower === 'umbilical' ? 5 : 3.5)) - tw;
    const baseY = mountH; // pad deck / ML deck top = vehicle base plane
    const H = tower === 'umbilical' ? towerH * 0.92 : towerH * (tower === 'ml' ? 1.07 : 1.02);
    const b = at(tx, baseY), top = at(tx, H + baseY);
    const lc = tower === 'ml' ? ['#7c8084', '#2a2c30'] : tower === 'fss' ? ['#b6aea4', '#55504a'] : steel;
    {
      const g = ctx.createLinearGradient(b.x, 0, b.x + tw * s, 0);
      const k = tower === 'umbilical' ? 0.3 : tower === 'ml' ? 0.85 : 0.62;
      g.addColorStop(lit ? 0 : 1, `rgba(92,94,96,${k})`); g.addColorStop(lit ? 1 : 0, `rgba(30,31,33,${k})`);
      ctx.fillStyle = g; ctx.fillRect(b.x, top.y, tw * s, b.y - top.y);
      if (tower !== 'umbilical') { // internal core: elevator shaft + piping
        ctx.fillStyle = 'rgba(20,21,23,0.55)'; ctx.fillRect(b.x + tw * s * 0.42, top.y, tw * s * 0.22, b.y - top.y);
        ctx.fillStyle = 'rgba(200,200,196,0.35)'; ctx.fillRect(b.x + tw * s * 0.78, top.y, Math.max(0.5, 0.35 * s), b.y - top.y);
      }
    }
    lattice2D(ctx, b.x, b.y, tw * s, b.y - top.y, (tower === 'umbilical' ? 3.2 : 6) * s, lc[0], lc[1], (tower === 'umbilical' ? 0.3 : 0.45) * s);
    if (tower !== 'umbilical') lattice2D(ctx, b.x + tw * s * 0.3, b.y, tw * s * 0.4, b.y - top.y, 3 * s, 'rgba(150,150,150,0.5)', 'rgba(60,60,60,0.5)', 0.15 * s);
    // platforms with shadow lines
    ctx.fillStyle = 'rgba(25,26,28,0.55)';
    for (let y = 0; y < H; y += tower === 'umbilical' ? 9 : 6) { const p = at(tx, y + baseY); ctx.fillRect(b.x - 0.4 * s, p.y, (tw + 0.8) * s, Math.max(0.5, 0.35 * s)); }
    // lightning rod mast on top
    ctx.fillStyle = '#3a3c3e';
    const mh = tower === 'fss' ? 24 : 10;
    ctx.fillRect(b.x + tw * s / 2 - 0.25 * s, top.y - mh * s, 0.5 * s, mh * s);
    if (tower === 'fss') { // catenary lightning-protection wires from the mast to ground anchors
      const mx = b.x + tw * s / 2, my = top.y - mh * s;
      // thin, sun-lit steel cables: light grey, low contrast, fading with distance (anchors set back into depth)
      ctx.lineWidth = 0.45;
      for (const [ax, az] of [[-120, Z0 + 260], [-30, Z0 + 420]]) {
        const g = P(ax, az);
        const gr = ctx.createLinearGradient(mx, my, g.x, g.y);
        gr.addColorStop(0, 'rgba(214,218,222,0.34)'); gr.addColorStop(1, 'rgba(214,218,222,0.05)');
        ctx.strokeStyle = gr;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.quadraticCurveTo((mx + g.x) / 2, (my + g.y) / 2 + 8 * g.s, g.x, g.y); ctx.stroke();
      }
    }
    // access / umbilical arms reaching the vehicle
    const stackH = towerH / 1.05;
    const arms = tower === 'fss' ? [[stackH - 7.5, 3, true]] : tower === 'ml' ? [[stackH * 0.85, 2.4, true], [stackH * 0.76, 1.6], [stackH * 0.68, 1.4], [stackH * 0.53, 1.8], [stackH * 0.12, 1.4]] : [[stackH * 0.8, 1], [stackH * 0.45, 0.8]];
    for (const [ay, ah, crew] of arms) {
      const reach = Math.max(0, (-tx - tw) - 1.0) * clamp(towerArm, 0, 1);
      const p = at(tx + tw, ay + baseY);
      if (tower === 'umbilical') {
        // umbilical boom + hose to a port on the vehicle skin; once released the hose swings back and hangs against the mast
        const arm = clamp(towerArm, 0, 1), x1 = P(-vR + 0.15, Z0).x, py = p.y + 1.5 * s;
        ctx.fillStyle = '#3a3c40'; ctx.fillRect(p.x, p.y - 0.6 * s, 1.6 * s, 1.2 * s); // boom stub
        ctx.strokeStyle = '#26282a'; ctx.lineWidth = Math.max(0.6, 0.45 * s);
        ctx.beginPath(); ctx.moveTo(p.x + 1.4 * s, p.y);
        if (arm > 0.02) {
          const ex = p.x + 1.4 * s + (x1 - p.x - 1.4 * s) * arm, ey = py;
          ctx.quadraticCurveTo((p.x + ex) / 2, Math.max(p.y, ey) + (2 + 4 * (1 - arm)) * s, ex, ey); ctx.stroke();
          if (arm > 0.97) { ctx.fillStyle = '#4a4c50'; ctx.fillRect(x1 - 0.5 * s, py - 0.7 * s, 0.7 * s, 1.4 * s); } // connector plate on the skin
        } else { ctx.quadraticCurveTo(p.x + 2.4 * s, p.y + 5 * s, p.x + 1.8 * s, p.y + 9 * s); ctx.stroke(); }
        continue;
      }
      // the crew access arm is attached to the FSS at its real height and swings back ~T-42 min: in every shot we
      // show (T-30 s onward) it is parked against the tower, seen end-on as a short stub with its white room
      const armLen = crew && tower === 'fss' ? 2.6 : reach;
      if (armLen < 0.2) continue;
      if (crew && tower === 'fss') {
        const g2 = ctx.createLinearGradient(p.x, 0, p.x + armLen * s, 0);
        g2.addColorStop(0, '#d8d8d2'); g2.addColorStop(1, '#8e908c');
        ctx.fillStyle = g2; ctx.fillRect(p.x, p.y - ah * s, armLen * s, ah * s);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(p.x, p.y, armLen * s, Math.max(0.6, 0.3 * s));
        continue;
      }
      const g2 = ctx.createLinearGradient(0, p.y - ah * s, 0, p.y);
      g2.addColorStop(0, crew ? '#f2f2ee' : '#9da1a6'); g2.addColorStop(1, crew ? '#a8aaa8' : '#5a5e62');
      ctx.fillStyle = g2; ctx.fillRect(p.x, p.y - ah * s, reach * s, ah * s);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(p.x, p.y, reach * s, Math.max(0.6, 0.3 * s));
    }
    if (tower === 'ml') {
      // Mobile Launcher: a ~50 m wide two-storey steel deck on pedestals over the flame trench; the SRB aft
      // skirts rest on hold-down posts on the deck top (= vehicle base plane)
      const deckH = mountH * 0.62, x0 = Math.min(at(-34, 0).x, b.x - 4 * s), x1 = at(34, 0).x;
      const top0 = at(0, mountH).y, bot = top0 + deckH * s, gnd = at(0, 0).y;
      for (const px of [-30, -16, 16, 30]) { // pedestals
        const q = at(px, 0);
        const g = ctx.createLinearGradient(q.x - 1.6 * s, 0, q.x + 1.6 * s, 0); g.addColorStop(0, '#8d8a84'); g.addColorStop(1, '#55534f');
        ctx.fillStyle = g; ctx.fillRect(q.x - 1.6 * s, bot, 3.2 * s, gnd - bot);
      }
      ctx.fillStyle = '#0c0c0d'; ctx.fillRect(at(-12, 0).x, bot, 24 * s, gnd - bot); // trench opening under the deck
      const g3 = ctx.createLinearGradient(0, top0, 0, bot);
      g3.addColorStop(0, '#5d6166'); g3.addColorStop(0.08, '#4a4e53'); g3.addColorStop(1, '#2a2c30');
      ctx.fillStyle = g3; ctx.fillRect(x0, top0, x1 - x0, bot - top0);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = Math.max(0.5, 0.2 * s); ctx.beginPath();
      for (let xx = x0; xx < x1; xx += 4 * s) { ctx.moveTo(xx, top0 + 1 * s); ctx.lineTo(xx, bot); }
      ctx.moveTo(x0, top0 + (bot - top0) * 0.5); ctx.lineTo(x1, top0 + (bot - top0) * 0.5); ctx.stroke();
      ctx.fillStyle = '#9a9ea2'; ctx.fillRect(x0, top0, x1 - x0, Math.max(0.6, 0.35 * s));
      ctx.fillStyle = '#0d0e0f'; ctx.fillRect(at(-10, 0).x, top0 + 0.5 * s, 20 * s, (bot - top0) * 0.8); // exhaust hole through the deck
      for (const hx of [-6.45, 6.45]) { // SRB hold-down posts
        const q = at(hx, mountH);
        ctx.fillStyle = '#6c7074'; ctx.fillRect(q.x - 1.6 * s, q.y - 1.6 * s, 0.9 * s, 1.6 * s); ctx.fillRect(q.x + 0.7 * s, q.y - 1.6 * s, 0.9 * s, 1.6 * s);
      }
    }
  }
  void t;
}

/** Infrastructure scattered around the pad, per style (water towers, lightning masts, tanks, buildings). */
function drawSiteProps(ctx, P, Z0, kind, lb, W) {
  const L0 = bucketLight(lb);
  const litX = L0.ax < 0 ? 0 : 1;
  const box = (X, Z, w, h, col, roof = null) => {
    const p = P(X, Z), s = p.s;
    if (p.x + w * s < -10 || p.x - w * s > W + 10) return;
    const g = ctx.createLinearGradient(p.x - w * s / 2, 0, p.x + w * s / 2, 0);
    const c = rgbOf(col);
    g.addColorStop(litX, cssOf(c.map((v) => v * 1.12))); g.addColorStop(1 - litX, cssOf(c.map((v) => v * 0.72)));
    ctx.fillStyle = g; ctx.fillRect(p.x - w * s / 2, p.y - h * s, w * s, h * s);
    if (roof) { ctx.fillStyle = roof; ctx.fillRect(p.x - w * s / 2, p.y - h * s, w * s, Math.max(0.6, h * s * 0.06)); }
  };
  const sphere = (X, Z, r) => {
    const p = P(X, Z), s = p.s, R = r * s;
    const g = ctx.createRadialGradient(p.x + L0.ax * R * 0.4, p.y - R * 1.2 + L0.ay * R * 0.4, R * 0.1, p.x, p.y - R * 1.15, R);
    g.addColorStop(0, '#fbfbf8'); g.addColorStop(0.7, '#c8cac8'); g.addColorStop(1, '#8a8c8c');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y - R * 1.15, R, 0, TAU); ctx.fill();
    ctx.fillStyle = '#6a6c6e'; ctx.fillRect(p.x - R * 0.7, p.y - R * 0.3, Math.max(0.5, R * 0.08), R * 0.3); ctx.fillRect(p.x + R * 0.62, p.y - R * 0.3, Math.max(0.5, R * 0.08), R * 0.3);
  };
  const waterTower = (X, Z, h) => {
    const p = P(X, Z), s = p.s;
    ctx.strokeStyle = '#7d8084'; ctx.lineWidth = Math.max(0.5, 0.6 * s);
    ctx.beginPath(); ctx.moveTo(p.x - 4 * s, p.y); ctx.lineTo(p.x - 2 * s, p.y - h * 0.8 * s); ctx.moveTo(p.x + 4 * s, p.y); ctx.lineTo(p.x + 2 * s, p.y - h * 0.8 * s); ctx.stroke();
    const g = ctx.createLinearGradient(p.x - 6 * s, 0, p.x + 6 * s, 0);
    g.addColorStop(litX, '#f4f4f0'); g.addColorStop(1 - litX, '#9c9e9e');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(p.x, p.y - h * 0.86 * s, 7 * s, 5 * s, 0, 0, TAU); ctx.fill();
  };
  const mast = (X, Z, h) => {
    const p = P(X, Z), s = p.s;
    lattice2D(ctx, p.x - 1 * s, p.y, 2 * s, h * s, 3 * s, '#a0a4a8', '#55595e', 0.2 * s);
    ctx.fillStyle = '#d8d8d4'; ctx.fillRect(p.x - 0.2 * s, p.y - (h + 12) * s, 0.4 * s, 12 * s);
    return { x: p.x, y: p.y - (h + 12) * s, X, Z };
  };
  // lightning-protection wires: each mast top runs down to two ground anchors outboard of it (never across the pad)
  const cat = (a, b) => {
    ctx.lineWidth = 0.4;
    for (const m of [a, b]) {
      const side = m.x < W / 2 ? -1 : 1;
      for (const [dx, dz] of [[40, 160], [15, 300]]) {
        const g = P(m.X + side * dx, m.Z + dz);
        const gr = ctx.createLinearGradient(m.x, m.y, g.x, g.y);
        gr.addColorStop(0, 'rgba(214,218,222,0.3)'); gr.addColorStop(1, 'rgba(214,218,222,0.04)');
        ctx.strokeStyle = gr;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.quadraticCurveTo((m.x + g.x) / 2, (m.y + g.y) / 2 + 6 * g.s, g.x, g.y); ctx.stroke();
      }
    }
  };
  if (kind === 'florida') {
    box(-1100, 5200, 158, 160, '#d9d6cc', '#8a8a86'); // VAB on the horizon
    ctx.fillStyle = 'rgba(30,60,120,0.35)'; { const p = P(-1100, 5200); ctx.fillRect(p.x - 40 * p.s, p.y - 120 * p.s, 30 * p.s, 30 * p.s); }
    waterTower(140, Z0 + 260, 88);
    sphere(-120, Z0 + 140, 9); sphere(-150, Z0 + 150, 9);
    box(90, Z0 + 120, 40, 14, '#c9c6bd', '#77746c');
  } else if (kind === 'bocachica') {
    box(-380, Z0 + 600, 60, 28, '#b8bcc0', '#6e7276'); // tank farm buildings
    for (let i = 0; i < 6; i++) { const p = P(-160 + i * 9, Z0 + 120), s = p.s; const g = ctx.createLinearGradient(p.x - 4 * s, 0, p.x + 4 * s, 0); g.addColorStop(litX, '#e6e8ea'); g.addColorStop(1 - litX, '#80858a'); ctx.fillStyle = g; ctx.fillRect(p.x - 4 * s, p.y - 25 * s, 8 * s, 25 * s); }
    sphere(140, Z0 + 160, 8);
  } else if (kind === 'china') {
    box(-260, Z0 + 420, 60, 40, '#e8e6e0', '#a03a2a');
    const a = mast(-60, Z0 + 30, 80), b = mast(60, Z0 + 30, 80); cat(a, b);
    sphere(120, Z0 + 150, 7);
  } else if (kind === 'india') {
    box(-300, Z0 + 500, 50, 70, '#e4e2dc', '#8a8a86');
    const a = mast(-65, Z0 + 35, 90), b = mast(65, Z0 + 35, 90); cat(a, b);
  } else if (kind === 'kourou') {
    const a = mast(-70, Z0 + 40, 75), b = mast(70, Z0 + 40, 75); cat(a, b);
    box(260, Z0 + 600, 40, 60, '#e8e8e4', '#5a6a8a');
  } else if (kind === 'baikonur') {
    box(-320, Z0 + 700, 50, 18, '#a8a090', '#6a645a');
    box(240, Z0 + 520, 20, 30, '#b0a898', '#6a645a');
    for (let i = 0; i < 4; i++) { const p = P(-60 + i * 40, Z0 + 260), s = p.s; ctx.strokeStyle = '#5a5650'; ctx.lineWidth = Math.max(0.4, 0.3 * s); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 28 * s); ctx.stroke(); }
  } else if (kind === 'small') {
    box(-60, Z0 + 80, 18, 6, '#e0e0dc', '#7a7a76');
  } else {
    box(-180, Z0 + 260, 36, 16, '#c9c6bd', '#77746c');
    sphere(110, Z0 + 140, 6);
  }
}

/** Ground plane, horizon, pad and tower (not the vehicle). groundY = pad surface (screen y). */
export function drawLaunchSite(ctx, view, { style = 'generic', groundY, pxPerM = 4, t = 0, tower = 'umbilical', towerArm = 1, towerHeightM = 80, reduce = false, vehicleD = 7, light = null } = {}) {
  void reduce;
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const gy = num(groundY, H * 0.8), p = Math.max(0.05, num(pxPerM, 4));
  if (!(gy < H + 600)) return;
  const st = SITES[style] || SITES.generic;
  tower = MOUNT_H[tower] != null ? tower : 'umbilical';
  const mountH = MOUNT_H[tower];
  const gyG = gy + mountH * p;               // surrounding ground level at the pad's depth
  const gap = clamp(20 + p * 2.6, 22, 90);    // horizon above that ground
  const hor = gyG - gap;
  if (hor > H + 20) return;
  const f = H, hc = gap / p, Z0 = f / p;
  const lb = lightBucket(light || { ax: -0.95, ay: -0.31 });
  const P = projector(W, hor, hc, f, 0);
  const vR = Math.max(1, num(vehicleD, 7) / 2);
  ctx.save();
  // --- horizon: sea / distant land
  const skyH = skyColors('earth', 0).horizon;
  if (st.far) {
    const fs = ridgeStrip(st.far.kind, st.far.colors, lb, hash(style + 'far'), st.humid ? 0.55 : 0.45, cssToHex(skyH));
    drawStripAtDepth(ctx, W, fs, hor, hc, f, st.far.Z, st.far.Z * 1.6, st.far.h, 0);
  }
  ctx.fillStyle = st.ground[1];
  ctx.fillRect(-10, hor, W + 20, H - hor + 20);
  let landTop = hor;
  if (st.sea) {
    const yShore = hor + hc * (f / st.seaZ);
    const g = ctx.createLinearGradient(0, hor, 0, yShore + 1);
    g.addColorStop(0, cssOf(mixc(st.sea, cssToHex(skyH), 0.55))); g.addColorStop(1, st.sea);
    ctx.fillStyle = g; ctx.fillRect(-10, hor - 0.5, W + 20, yShore - hor + 1.5);
    // sun glitter streaks on the water
    const R = rng(hash(style + 'glit'));
    ctx.fillStyle = 'rgba(255,250,235,0.5)';
    for (let i = 0; i < 26; i++) { const yy = hor + R() * (yShore - hor); ctx.fillRect(R() * W * 0.6, yy, 2 + R() * 10, 0.5); }
    landTop = yShore;
    // beach line
    ctx.fillStyle = st.accent; ctx.fillRect(-10, yShore - 0.3, W + 20, Math.max(0.8, (yShore - hor) * 0.12 + 0.6));
  }
  if (st.fog) {
    const g = ctx.createLinearGradient(0, hor - gap * 0.6, 0, hor + 2);
    g.addColorStop(0, 'rgba(235,238,240,0)'); g.addColorStop(1, 'rgba(235,238,240,0.8)');
    ctx.fillStyle = g; ctx.fillRect(-10, hor - gap * 0.6, W + 20, gap * 0.6 + 2);
  }
  // --- ground plane
  groundPlane(ctx, W, hor, landTop + 0.5, H + 4, hc, f, 0, 0, [
    { key: `stile|${style}|mega|${lb}`, tile: siteGroundTile(style, 'mega', lb), tileM: 900, mode: 'base' },
    { key: `stile|${style}|fine|${lb}`, tile: siteGroundTile(style, 'fine', lb), tileM: 14, mode: 'overlay', alpha: 0.8 },
  ]);
  // --- tree lines and infrastructure (far → near)
  for (const v of st.veg || []) drawStripAtDepth(ctx, W, vegStrip(v.kind, lb, v.tint), hor, hc, f, v.Z, v.Z * 0.9, v.h * 1.4, 0);
  drawSiteProps(ctx, P, Z0, st.props, lb, W);
  // aerial haze over the distance
  {
    const g = ctx.createLinearGradient(0, hor - gap, 0, gyG);
    const hz = st.humid ? 0.55 : st.grey ? 0.45 : 0.35;
    g.addColorStop(0, `rgba(214,226,234,0)`); g.addColorStop(0.45, `rgba(214,226,234,${hz})`); g.addColorStop(1, 'rgba(214,226,234,0)');
    ctx.fillStyle = g; ctx.fillRect(-10, hor - gap, W + 20, gyG - hor + gap);
  }
  // --- hardstand (concrete apron) as a projected ground quad with concrete texture
  {
    const a = P(-55, Z0 - 40), b = P(55, Z0 - 40), c2 = P(70, Z0 + 45), d = P(-70, Z0 + 45);
    ctx.save();
    ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.closePath(); ctx.clip();
    groundPlane(ctx, W, hor, d.y - 1, Math.min(H + 4, a.y + 1), hc, f, 0, 0, [{ key: `concrete|${lb}`, tile: concreteTile(lb), tileM: 40, mode: 'base' }]);
    // scorch around the trench exit
    const sc = P(0, Z0);
    const g = ctx.createRadialGradient(sc.x, sc.y, 0, sc.x, sc.y, 40 * sc.s);
    g.addColorStop(0, 'rgba(30,26,22,0.6)'); g.addColorStop(1, 'rgba(30,26,22,0)');
    ctx.save(); ctx.translate(sc.x, sc.y); ctx.scale(1, Math.max(0.05, (sc.y - hor) / f) * 4); ctx.translate(-sc.x, -sc.y);
    ctx.fillStyle = g; ctx.fillRect(sc.x - 40 * sc.s, sc.y - 40 * sc.s, 80 * sc.s, 80 * sc.s); ctx.restore();
    ctx.restore();
  }
  // --- tower (behind the mount; the vehicle is drawn later by the composer)
  drawTowerType(ctx, P, Z0, tower, Math.max(10, num(towerHeightM, 80)), vR, num(towerArm, 1), mountH, lb, t);
  // --- pad mount / flame trench face under the vehicle
  const s = p;
  const cx = W / 2;
  if (tower === 'mechazilla') {
    // orbital launch mount: stainless table on six legs, deflector plate below
    const tw = 14 * s, legH = mountH * s;
    ctx.fillStyle = '#2a2c2e'; ctx.fillRect(cx - tw * 0.5, gyG - 1.2 * s, tw, 1.2 * s);
    for (const lx of [-0.5, -0.17, 0.17, 0.5]) {
      const g = ctx.createLinearGradient(cx + lx * tw - 1.2 * s, 0, cx + lx * tw + 1.2 * s, 0);
      g.addColorStop(0, '#c8ccd0'); g.addColorStop(0.5, '#8d9196'); g.addColorStop(1, '#5a5e62');
      ctx.fillStyle = g; ctx.fillRect(cx + lx * tw - 1.2 * s, gy, 2.4 * s, legH);
    }
    const g2 = ctx.createLinearGradient(0, gy - 2.5 * s, 0, gy + 3.5 * s);
    g2.addColorStop(0, '#d4d8dc'); g2.addColorStop(0.5, '#90959a'); g2.addColorStop(1, '#55595e');
    ctx.fillStyle = g2; ctx.fillRect(cx - tw * 0.62, gy, tw * 1.24, 3.5 * s);
    ctx.fillStyle = '#1c1d1f'; ctx.fillRect(cx - tw * 0.62, gy + 3.5 * s, tw * 1.24, Math.max(0.6, 0.6 * s));
  } else if (tower !== 'ml') {
    const mw = (tower === 'tulip' ? 34 : 26) * s;
    const g = ctx.createLinearGradient(0, gy, 0, gyG);
    g.addColorStop(0, '#b4b0a6'); g.addColorStop(0.15, '#8f8b82'); g.addColorStop(1, '#6a665e');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(cx - mw * 0.5, gy); ctx.lineTo(cx + mw * 0.5, gy); ctx.lineTo(cx + mw * 0.62, gyG); ctx.lineTo(cx - mw * 0.62, gyG); ctx.closePath(); ctx.fill();
    // flame trench / exhaust opening (dark, sooty interior)
    const tw2 = (tower === 'tulip' ? 16 : 9) * s, th = mountH * s * 0.85;
    const g2 = ctx.createLinearGradient(0, gyG - th, 0, gyG);
    g2.addColorStop(0, '#0b0b0c'); g2.addColorStop(1, '#2a2622');
    ctx.fillStyle = g2;
    if (tower === 'tulip') { // the pit opens right under the rocket: a dark mouth with a sunlit concrete lip
      ctx.beginPath(); ctx.moveTo(cx - tw2 * 0.5, gy + 0.4 * s); ctx.lineTo(cx + tw2 * 0.5, gy + 0.4 * s); ctx.lineTo(cx + tw2 * 0.36, gyG); ctx.lineTo(cx - tw2 * 0.36, gyG); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(230,226,214,0.55)'; ctx.fillRect(cx - tw2 * 0.5, gy, tw2, Math.max(0.6, 0.4 * s));
    } else ctx.fillRect(cx - tw2 / 2 + tw2 * 0.6, gyG - th, tw2, th);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(cx - mw * 0.5, gy, mw, Math.max(0.6, 0.3 * s));
  }
  ctx.restore();
}

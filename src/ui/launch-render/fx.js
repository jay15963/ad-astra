// launch-render/fx.js — pooled particle system + pure effect painters (plumes, Mach diamonds, condensation
// collar, parachutes, re-entry plasma). Contract: README.md §5.3.
//
// Look: photographic, not cartoon. Every effect is built from a few *cached* procedurally generated sprites
// (lit cauliflower smoke puffs, lumpy fire blobs, soft glows, plume textures with baked shock diamonds,
// condensation-collar and plasma-sheath textures). Per frame we only blit them (drawImage) — no per-pixel
// work, no ctx.filter, no shadowBlur. All randomness is seeded (no Math.random).
//
// Positions are screen CSS px (y down). Angles follow canvas convention; for plumes / plasma `angle` is the
// direction the exhaust / wake streams (0 = straight down the screen).

import { rng, cached } from './textures.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ local noise (sprite generation only)

function h2(ix, iy, s) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(s | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy, s), b = h2(ix + 1, iy, s), c = h2(ix, iy + 1, s), d = h2(ix + 1, iy + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, oct, s) {
  let amp = 1, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * f, y * f, s + i * 131); norm += amp; amp *= 0.5; f *= 2.03; }
  return sum / norm;
}

// ------------------------------------------------------------------ environment

/** Ambient pressure (bar) at altitude on a world. */
export function ambientPressure(world, altKm) {
  const h = Math.max(0, Number(altKm) || 0);
  switch (world) {
    case 'earth': return 1.013 * Math.exp(-h / 8.5);
    case 'mars': return 0.006 * Math.exp(-h / 11.1);
    case 'titan': return 1.47 * Math.exp(-h / 20);
    case 'venus': return 92 * Math.exp(-h / 15.9);
    default: return 0;
  }
}

/** 0 at sea level .. 1 in vacuum (plume widening). */
export function expansionOf(pBar) {
  const p = Math.max(0, Number(pBar) || 0);
  return Math.max(0, Math.min(1, 1 - Math.pow(p / 1.013, 0.35)));
}

const ATMOS = new Set(['earth', 'mars', 'titan', 'venus']);
const GRAVITY = { earth: 9.81, moon: 1.62, mars: 3.71, mercury: 3.7, venus: 8.87, europa: 1.31, titan: 1.35, ganymede: 1.43, callisto: 1.24, io: 1.8, enceladus: 0.11, triton: 0.78, pluto: 0.62, charon: 0.29, ceres: 0.28, vesta: 0.25, phobos: 0.0057, deimos: 0.003 };

/**
 * Plume palettes. String fields (core, mid, tail, smoke, diamonds) are kept for other modules; the renderer
 * itself uses the numeric fields: `ramp` = colour by local heat [tail, mid, hot, core] (RGB 0..255),
 * `dia` = shock-diamond colour, `diaK` = diamond strength, `L0/L1` = visible length in nozzle diameters at
 * sea level / extra in vacuum, `luminous` = overall brightness in daylight.
 */
export const PROPELLANT = {
  // RP-1/LOX (Merlin, RD-180, RD-107, YF-100): luminous yellow-orange, sooty, fuel-rich edge
  kerolox: {
    core: '#fffbea', mid: '#ffbe55', tail: 'rgba(255,110,30,0)', smoke: '#5e554c', diamonds: '#fff4c8', luminous: 1,
    ramp: [[160, 50, 14], [255, 122, 30], [255, 184, 70], [255, 236, 186]], dia: [255, 236, 190], diaK: 1.25, L0: 24, L1: 26, Wk: 1.15, opaque: 0.6,
    smoke2: 'kero_contrail', smokeA: 0.6, smokeRate: 16, smokeGrow: 6, soot: 0.12, glow: [255, 150, 60],
  },
  // LH2/LOX (RS-25, Vulcain, RL10, LE-7, CE-20): nearly transparent, bright Mach disks
  hydrolox: {
    core: '#f4f8ff', mid: 'rgba(170,200,255,0.55)', tail: 'rgba(150,180,255,0)', smoke: '#e8ecf0', diamonds: '#cfe0ff', luminous: 0.45,
    ramp: [[110, 90, 160], [190, 160, 210], [245, 210, 220], [255, 246, 236]], dia: [255, 226, 200], diaK: 1.7, L0: 13, L1: 30, Wk: 0.95, opaque: 0.08,
    smoke2: 'vapor', smokeA: 0.34, smokeRate: 9, smokeGrow: 4, soot: 0, glow: [210, 190, 255],
  },
  // CH4/LOX (Raptor, BE-4, TQ-12): blue-violet at the throat, clean orange-white body, crisp diamonds
  methalox: {
    core: '#f2eaff', mid: 'rgba(255,170,110,0.8)', tail: 'rgba(255,140,90,0)', smoke: '#d8d4d0', diamonds: '#fff0e0', luminous: 0.85,
    ramp: [[150, 50, 80], [240, 112, 84], [255, 176, 130], [246, 226, 255]], dia: [255, 238, 220], diaK: 1.0, L0: 19, L1: 28, Wk: 1.05, opaque: 0.4,
    smoke2: 'metha', smokeA: 0.26, smokeRate: 8, smokeGrow: 4, soot: 0, glow: [255, 170, 120],
  },
  // APCP solid motors (SRBs, P120, S200): blinding white-yellow, long, thick white smoke column
  solid: {
    core: '#ffffff', mid: '#ffe6b0', tail: 'rgba(255,190,120,0)', smoke: '#f0eeea', diamonds: '#fff8e0', luminous: 1.25,
    ramp: [[220, 110, 40], [255, 186, 92], [255, 236, 186], [255, 255, 248]], dia: [255, 250, 230], diaK: 0, L0: 28, L1: 20, Wk: 1.5, opaque: 0.85,
    smoke2: 'solid', smokeA: 0.88, smokeRate: 20, smokeGrow: 9, soot: 0, glow: [255, 210, 140],
  },
  // UDMH/NTO (Proton, Long March 2/3/4, Vikas, Draco): translucent orange, reddish-brown NO2 smoke
  hypergolic: {
    core: '#fff0d0', mid: 'rgba(255,170,90,0.75)', tail: 'rgba(200,110,60,0)', smoke: '#b07a4a', diamonds: '#ffe0b0', luminous: 0.75,
    ramp: [[140, 50, 26], [232, 112, 52], [255, 182, 106], [255, 236, 200]], dia: [255, 214, 170], diaK: 0.5, L0: 16, L1: 24, Wk: 1.0, opaque: 0.35,
    smoke2: 'no2', smokeA: 0.5, smokeRate: 10, smokeGrow: 6, soot: 0, glow: [255, 160, 90],
  },
};
const propOf = (p) => PROPELLANT[p] || PROPELLANT.kerolox;
const propKey = (p) => (PROPELLANT[p] ? p : 'kerolox');

// ------------------------------------------------------------------ sprite factory

/** Build an RGBA sprite from a per-pixel function fill(data, w, h). Cached in the shared LRU + local memo. */
const MEMO = new Map();
function sprite(key, w, h, fill) {
  const m = MEMO.get(key);
  if (m) return m;
  const c = cached('fx|' + key, w, h, (ctx, W, H) => {
    const img = ctx.createImageData(W, H);
    fill(img.data, W, H);
    ctx.putImageData(img, 0, 0);
  });
  if (c) MEMO.set(key, c);
  return c;
}
function put(d, i, r, g, b, a) {
  d[i] = r > 255 ? 255 : r; d[i + 1] = g > 255 ? 255 : g; d[i + 2] = b > 255 ? 255 : b; d[i + 3] = a > 1 ? 255 : a < 0 ? 0 : a * 255;
}

// palette for tinted particles (index → RGB)
const PAL = [
  [255, 255, 255], // 0 white
  [238, 241, 243], // 1 steam (deluge)
  [92, 84, 76], //    2 kerolox soot (fuel-rich, brownish)
  [228, 227, 224], // 3 kerolox contrail (condensed water + a little soot: pale grey-white)
  [241, 244, 247], // 4 water vapour (hydrolox)
  [236, 234, 228], // 5 solid motor smoke (Al2O3)
  [214, 211, 206], // 6 methalox (faint)
  [178, 122, 76], //  7 hypergolic NO2
  [58, 54, 52], //    8 explosion smoke
  [158, 154, 146], // 9 lunar regolith
  [190, 128, 86], //  10 martian dust
  [118, 88, 52], //   11 titan tholin sand
  [200, 186, 158], // 12 earth sand
  [255, 138, 42], //  13 heat (fire-lit)
  [246, 250, 255], // 14 LOX boil-off vapour
  [138, 126, 112], // 15 mercury / rocky regolith (warmer)
  [222, 220, 214], // 16 icy dust (europa, enceladus)
  [255, 214, 150], // 17 spark / ember
  [190, 214, 255], // 18 ice flake glint
  [255, 236, 210], // 19 pale flash
];
const P = { white: 0, steam: 1, soot: 2, kero_contrail: 3, vapor: 4, solid: 5, metha: 6, no2: 7, xsmoke: 8, moon: 9, mars: 10, titan: 11, sand: 12, heat: 13, lox: 14, rock: 15, ice: 16, spark: 17, glint: 18, flash: 19 };
const DUST_PAL = { moon: P.moon, mars: P.mars, titan: P.titan, earth: P.sand, mercury: P.rock, europa: P.ice, enceladus: P.ice, ganymede: P.rock, callisto: P.rock, io: P.sand, phobos: P.rock, deimos: P.rock, ceres: P.rock, vesta: P.rock, pluto: P.ice, triton: P.ice, charon: P.ice };
// fire colour over life: white-hot → yellow → orange → red → dark red
const FIRE = [[255, 250, 232], [255, 222, 140], [255, 170, 70], [246, 112, 34], [196, 60, 22], [110, 30, 14]];

const PUFF = 64;
const PUFF_BASE = new Map();
/** Lit cauliflower puff base: Float32 lum + alpha, per variant and light bucket. */
function puffBase(v, lb) {
  const key = v * 8 + lb;
  let b = PUFF_BASE.get(key);
  if (b) return b;
  const S = PUFF, seed = 101 + v * 977;
  const n = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = ((x + 0.5) / S) * 2 - 1, w = ((y + 0.5) / S) * 2 - 1;
    n[y * S + x] = fbm(u * 2.1 + v * 3.7, w * 2.1 - v * 1.3, 4, seed);
  }
  const ang = (lb / 8) * TAU;
  let lx = Math.cos(ang), ly = Math.sin(ang), lz = 0.55;
  const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
  const lum = new Float32Array(S * S), al = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    const u = ((x + 0.5) / S) * 2 - 1, w = ((y + 0.5) / S) * 2 - 1;
    const r = Math.hypot(u, w);
    const nn = n[i];
    const edge = 1 - r * 1.05 + (nn - 0.5) * 1.1;
    const a = smooth(0.0, 0.42, edge);
    // normal: sphere + noise bumps (cauliflower lobes catch the sun)
    const gx = (n[y * S + Math.min(S - 1, x + 1)] - n[y * S + Math.max(0, x - 1)]) * 6;
    const gy = (n[Math.min(S - 1, y + 1) * S + x] - n[Math.max(0, y - 1) * S + x]) * 6;
    let nx = u * 0.85 - gx, ny = w * 0.85 - gy, nz = Math.sqrt(Math.max(0.05, 1 - r * r * 0.8));
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
    lum[i] = Math.min(1.06, 0.5 + 0.52 * diff + 0.1 * (nn - 0.5));
    al[i] = a;
  }
  b = { lum, al };
  PUFF_BASE.set(key, b);
  return b;
}
function puffSprite(pal, v, lb) {
  return sprite(`puff|${pal}|${v}|${lb}`, PUFF, PUFF, (d) => {
    const { lum, al } = puffBase(v, lb);
    const [r, g, b] = PAL[pal] || PAL[0];
    for (let i = 0; i < lum.length; i++) {
      const L = lum[i];
      // shadows pick up a little cool sky fill; lit lobes stay neutral
      put(d, i * 4, r * L, g * L, b * (L + (1 - L) * 0.07), al[i]);
    }
  });
}
/** Soft additive glow (gaussian), tinted. */
function glowSprite(rgb, key) {
  return sprite(`glow|${key}`, 64, 64, (d, W) => {
    const e4 = Math.exp(-4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W) * 2 - 1, w = ((y + 0.5) / W) * 2 - 1;
      const r2 = u * u + w * w;
      const a = r2 >= 1 ? 0 : (Math.exp(-4 * r2) - e4) / (1 - e4);
      put(d, (y * W + x) * 4, rgb[0], rgb[1], rgb[2], a);
    }
  });
}
/** Lumpy fire blob (additive), tinted by fire-ramp step. */
function fireSprite(step, v) {
  return sprite(`fire|${step}|${v}`, 64, 64, (d, W) => {
    const [r, g, b] = FIRE[step];
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W) * 2 - 1, w = ((y + 0.5) / W) * 2 - 1;
      const rr = Math.hypot(u, w);
      const n = fbm(u * 2.6 + v * 5, w * 2.6, 4, 707 + v * 31);
      const a = smooth(0, 0.55, 1 - rr * 1.05 + (n - 0.5) * 0.9) * (0.55 + 0.75 * n);
      put(d, (y * W + x) * 4, r, g, b, a);
    }
  });
}
/** Thin soft ring (shockwave / water ripple). */
function ringSprite() {
  return sprite('ring', 128, 128, (d, W) => {
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W) * 2 - 1, w = ((y + 0.5) / W) * 2 - 1;
      const r = Math.hypot(u, w);
      const a = Math.exp(-(((r - 0.86) / 0.07) ** 2)) * (r < 1 ? 1 : 0) + 0.12 * smooth(0.86, 0.3, r) * (r < 0.86 ? 1 : 0);
      put(d, (y * W + x) * 4, 255, 255, 255, a);
    }
  });
}

// ------------------------------------------------------------------ plume textures

const NB = 9; // expansion buckets (0 = sea level .. NB-1 = hard vacuum)
const PW = 64, PH = 256;
const plumeWf = (Pp, ex) => 2.4 * (Pp.Wk || 1) + 13.6 * Math.pow(ex, 1.6) + 26 * Math.pow(ex, 3); // texture width in nozzle diameters
const plumeLf = (Pp, ex) => Pp.L0 + Pp.L1 * ex * (1 - 0.3 * ex * ex) + 22 * ex * ex * ex; // texture length in nozzle diameters (the underexpanded bell trails far behind)

const sstep01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
const VAC_GLOW = [196, 212, 240];
function plumeTex(prop, b) {
  return sprite(`plume|${prop}|${b}`, PW, PH, (d) => {
    const Pp = propOf(prop);
    const ex = b / (NB - 1);
    const Wf = plumeWf(Pp, ex), Lf = plumeLf(Pp, ex);
    const r0 = 1 / Wf; // nozzle half-width as a fraction of the texture half-width
    const rmax = 0.8 + 0.15 * ex;
    // vacuum: the boundary turns outward at the lip but keeps opening along the length (a bell / jellyfish,
    // not a round fan): a gentle power law instead of an instant flare
    const shapeK = 1 + 2.4 * ex;
    const vis = 1 - 0.3 * ex; // the underexpanded vacuum bell stays visible: thin but huge, lit by the sun
    const coreV = (1.6 * (1 + 3 * ex)) / Lf;
    const vacK = sstep01((ex - 0.35) / 0.5); // 0 = dense collimated flame, 1 = translucent underexpanded bell
    const seed = 3001 + b * 17 + prop.length * 101;
    const nc = ex < 0.6 ? Math.round(7 - 8 * ex) : 0; // shock cells
    const diaW = Pp.diaK * (1 - ex / 0.6);
    const R = Pp.ramp;
    for (let y = 0; y < PH; y++) {
      const v = (y + 0.5) / PH;
      const z = v * Lf; // distance from exit in diameters
      const shape = 1 - Math.pow(1 - v, shapeK);
      const rv = r0 + (rmax - r0) * shape;
      const A = Math.pow(1 - v, 0.55 + 1.5 * ex * (1 - vacK) + 0.75 * vacK) * smooth(0, 0.02, v + 0.01);
      for (let x = 0; x < PW; x++) {
        const u = ((x + 0.5) / PW) * 2 - 1;
        const n1 = fbm(u * 3.2, v * 7 + 0.3, 3, seed);
        const n2 = fbm(u * 9, v * 2.2, 3, seed + 57); // streaks along the axis
        const rr = rv * (1 + (n1 - 0.5) * 0.7 * v);
        const q = (u + (n1 - 0.5) * 0.08 * v) / rr;
        let body = A * Math.exp(-Math.pow(q * q, 2 - 0.55 * ex) * (1.0 + 1.2 * ex)) * (1 + (n2 - 0.5) * 1.2 * (1 - 0.75 * ex)) * (1 - 0.35 * v * (1 - n1));
        if (vacK > 0) {
          // translucent bell: dim filled interior + a brighter outer shock envelope (the plume boundary seen
          // edge-on), axial streaks, fading slowly along a long length
          const aq = Math.abs(q);
          const env = Math.exp(-(((aq - 0.86) / 0.13) ** 2)) * (0.75 + 0.5 * n1);
          const fill = Math.exp(-aq * aq * 1.5) * (0.85 + (n2 - 0.5) * 0.7);
          const bell = A * (0.42 * fill + 0.36 * env * (1 - 0.6 * v)) * (aq < 1.25 ? 1 : Math.exp(-(((aq - 1.25) / 0.12) ** 2)));
          body = body * (1 - vacK) + bell * vacK;
        }
        const qc = u / (r0 * 0.62 * (1 + 2.2 * ex));
        const core = Math.exp(-qc * qc * 2.4) * Math.exp(-v / coreV);
        // shock diamonds: bright rhombi + Mach disk at each cell front
        let dia = 0;
        if (nc && diaW > 0) {
          const ua = Math.abs(u) * Wf * 0.5; // |u| in diameters
          let zk = 1.25, sp = 1.2;
          for (let k = 1; k <= nc; k++) {
            const s = 1 - Math.abs(z - zk) / (0.5 * sp) - ua / 0.36;
            if (s > 0) dia += Math.pow(s, 0.8) * Math.pow(1 - (k - 1) / (nc + 1), 1.3);
            const md = Math.exp(-(((z - (zk - 0.38 * sp)) / 0.1) ** 2)) * Math.exp(-((ua / 0.22) ** 2));
            dia += md * 0.7 * Math.pow(1 - (k - 1) / (nc + 1), 1.5);
            zk += sp; sp *= 1.07;
          }
          dia *= diaW;
        }
        // heat → colour ramp (tail → mid → hot → core), then add diamonds and the white-hot throat
        const h = Math.min(1.4, body * 0.82 + core * 0.6);
        let cr, cg, cb;
        if (h < 0.33) { const f = h / 0.33; cr = R[0][0] + (R[1][0] - R[0][0]) * f; cg = R[0][1] + (R[1][1] - R[0][1]) * f; cb = R[0][2] + (R[1][2] - R[0][2]) * f; }
        else if (h < 0.7) { const f = (h - 0.33) / 0.37; cr = R[1][0] + (R[2][0] - R[1][0]) * f; cg = R[1][1] + (R[2][1] - R[1][1]) * f; cb = R[1][2] + (R[2][2] - R[1][2]) * f; }
        else { const f = Math.min(1, (h - 0.7) / 0.45); cr = R[2][0] + (R[3][0] - R[2][0]) * f; cg = R[2][1] + (R[3][1] - R[2][1]) * f; cb = R[2][2] + (R[3][2] - R[2][2]) * f; }
        // in near-vacuum the gas outside the hot core is no longer flame-coloured: a translucent sunlit white-blue bell
        const cool = ex > 0.45 ? sstep01((ex - 0.45) / 0.45) * (1 - Math.min(1, core * 1.6)) : 0;
        if (cool > 0) { cr += (206 - cr) * cool * 0.85; cg += (220 - cg) * cool * 0.85; cb += (246 - cb) * cool * 0.85; }
        const a1 = Math.min(1, Math.pow(h, 0.85) * (1 + 0.8 * cool)) * vis;
        let rr2 = cr * a1, gg2 = cg * a1, bb2 = cb * a1;
        rr2 += Pp.dia[0] * dia + 255 * core * 0.35; gg2 += Pp.dia[1] * dia + 250 * core * 0.35; bb2 += Pp.dia[2] * dia + 240 * core * 0.35;
        const a = Math.min(1, Math.max(rr2, gg2, bb2) / 255);
        const i = (y * PW + x) * 4;
        if (a <= 0.002) { d[i + 3] = 0; continue; }
        put(d, i, rr2 / a, gg2 / a, bb2 / a, a);
      }
    }
  });
}

function plumeGeom(Pp, ex, dPx) {
  return { len: dPx * plumeLf(Pp, ex), w: dPx * plumeWf(Pp, ex) };
}

/** One idle slice of prebuilding plume textures for these propellants (all expansion buckets). True when done. */
export function prewarmPlumes(props = []) {
  for (const p of props) { const k = propKey(p); for (let b = 0; b < NB; b++) if (!MEMO.has(`plume|${k}|${b}`)) { plumeTex(k, b); return false; } }
  return true;
}

// ------------------------------------------------------------------ pure painters

/** Engine plume from a nozzle exit (screen px). angle 0 = exhaust straight down the screen. */
export function drawPlume(ctx, nozzle, { prop = 'kerolox', pBar = 1, throttle = 1, pxPerM = 4, t = 0, angle = 0, lengthM, reduce = false, seed = 0 } = {}) {
  if (!ctx || !nozzle || !(throttle > 0)) return;
  const nx = num(nozzle.x), ny = num(nozzle.y);
  const k = propKey(prop), Pp = PROPELLANT[k];
  const ex = expansionOf(pBar);
  const ppm = Math.max(0.05, num(pxPerM, 4));
  const dPx = Math.max(1.2, num(nozzle.d, 1) * ppm);
  const th = Math.min(1.2, throttle);
  t = num(t); seed = num(seed);
  const flick = reduce ? 1 : 1 + 0.045 * Math.sin(t * 31 + seed * 1.7) + 0.03 * Math.sin(t * 57.3 + seed * 2.9) + 0.02 * Math.sin(t * 13.1 + seed);
  const fb = ex * (NB - 1);
  const b0 = Math.floor(fb), f = fb - b0;
  const lum = Math.min(1.25, Pp.luminous) * Math.min(1, th * 1.4);
  ctx.save();
  ctx.translate(nx, ny);
  ctx.rotate(num(angle));
  ctx.globalCompositeOperation = 'lighter';
  // broad glow (lights the air and the vehicle's aft end) (lights the air and the vehicle's aft end)
  const g = plumeGeom(Pp, ex, dPx);
  const lk = lengthM ? Math.min(1, (lengthM * ppm) / Math.max(1, g.len)) : 1; // a shortened plume is narrower too
  const glen = (lengthM ? lengthM * ppm : g.len) * (0.35 + 0.65 * th);
  const gs = glowSprite(Pp.glow, 'p' + k);
  if (gs) {
    const gw = Math.max(dPx * 3.2, g.w * 1.1 * lk);
    // flame-coloured air glow only where there is air; in vacuum nothing scatters the light (no brown haze)
    ctx.globalAlpha = clamp01(0.16 * lum * (1 - ex) * (1 - ex) * Math.min(1, Pp.luminous + 0.3));
    ctx.drawImage(gs, -gw / 2, -glen * 0.1, gw, glen * 0.75);
  }
  // body: crossfade the two nearest expansion buckets; within each, boil by crossfading mirrored copies
  const boil = reduce ? 0 : 0.32 * Math.sin(t * 8.7 + seed * 0.37);
  // a dense, luminous low-altitude flame hides the sky behind it (pure additive would wash out to white)
  const op = (Pp.opaque || 0) * (1 - ex) * (1 - ex) * Math.min(1, th * 1.4);
  for (let pass = op > 0.02 ? 0 : 1; pass < 2; pass++) {
  ctx.globalCompositeOperation = pass ? 'lighter' : 'source-over';
  for (let j = 0; j < 2; j++) {
    const b = Math.min(NB - 1, b0 + j);
    const wgt = j ? f : 1 - f;
    if (wgt < 0.02) continue;
    const tex = plumeTex(k, b);
    if (!tex) continue;
    const exb = b / (NB - 1);
    const gb = plumeGeom(Pp, exb, dPx);
    const len = (lengthM ? lengthM * ppm * (gb.len / Math.max(1, g.len)) : gb.len) * (0.35 + 0.65 * th) * flick;
    const w = Math.max(dPx * 1.2, gb.w * (0.85 + 0.15 * th) * lk);
    const base = clamp01(wgt * lum);
    if (!pass) { ctx.globalAlpha = clamp01(wgt * op); ctx.drawImage(tex, -w / 2, 0, w, len); continue; }
    ctx.globalAlpha = clamp01(base * (0.5 + boil));
    ctx.drawImage(tex, -w / 2, 0, w, len);
    ctx.save(); ctx.scale(-1, 1);
    ctx.globalAlpha = clamp01(base * (0.5 - boil));
    ctx.drawImage(tex, -w / 2, 0, w * (1 + (reduce ? 0 : 0.02 * Math.sin(t * 11 + seed))), len * (reduce ? 1 : 0.97));
    ctx.restore();
  }
  }
  // white-hot nozzle exit and throat glow bleeding onto the engine bay
  const hs = glowSprite([255, 246, 228], 'hot');
  if (hs) {
    const hw = dPx * (1.5 + 0.6 * ex) * (1 - 0.45 * ex);
    ctx.globalAlpha = clamp01(0.85 * (1 - 0.5 * ex) * Math.min(1, th * 1.5) * (Pp.luminous > 0.6 ? 1 : 0.7) * (reduce ? 1 : 0.92 + 0.08 * Math.sin(t * 41 + seed)));
    ctx.drawImage(hs, -hw / 2, -hw * 0.35, hw, hw * 0.9);
  }
  // hard vacuum: faint, enormous "jellyfish" halo from the underexpanded flow
  const vg = ex > 0.8 ? glowSprite(VAC_GLOW, 'vac') : null;
  if (vg) {
    const jw = dPx * 30 * lk * (ex - 0.8) / 0.2, jl = g.len * 0.9 * lk;
    ctx.globalAlpha = clamp01(0.06 * Math.min(1, th * 1.4) * ((ex - 0.8) / 0.2));
    ctx.drawImage(vg, -jw / 2, -jl * 0.08, jw, jl);
  }
  ctx.restore();
}

function collarTex(v) {
  return sprite(`collar2|${v}`, 128, 160, (d, W, H) => {
    const seed = 9100 + v * 71;
    const K = 0.55; // shock surface: aft distance w = K·r² (radius units) → paraboloid opening aft
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = (((x + 0.5) / W) * 2 - 1) * 1.5; // across, radius units
      const w = -0.15 + ((y + 0.5) / H) * 3.4;    // aft distance, radius units
      let a = 0;
      if (w > 0) {
        const rs = Math.sqrt(w / K);              // shell radius at this station
        const au = Math.abs(u);
        const streak = fbm(u * 3 + v * 5, w * 0.9, 4, seed);
        const fine = fbm(u * 14, w * 5, 2, seed + 7);
        if (au < rs * 1.08) {
          const q = Math.min(0.995, au / rs);
          const limb = 1 / Math.sqrt(1 - q * q * 0.96); // path length through a thin shell seen side-on
          const shell = Math.min(3, limb) * 0.5 * smooth(rs * 1.08, rs * 0.96, au);
          const lead = Math.exp(-(((w - K * au * au) / 0.06) ** 2)) * 1.1; // crisp shock front
          a = (shell + lead) * Math.exp(-w / (1.15 + 0.6 * streak)) * (0.6 + 0.9 * streak) * (0.8 + 0.4 * fine) * smooth(3.25, 2.2, w);
        }
      }
      const lum = 0.88 + 0.12 * clamp01(0.5 - u * 0.4);
      put(d, (y * W + x) * 4, 244 * lum, 248 * lum, 252 * lum, clamp01(a));
    }
  });
}

/** Prandtl–Glauert vapour cone around the vehicle near Max-Q. (x, y) = shock apex; cone flares aft. */
export function drawCondensationCollar(ctx, x, y, radiusPx, { intensity = 1, t = 0, angle = 0, reduce = false } = {}) {
  const I = clamp01(num(intensity));
  if (!ctx || !(I > 0)) return;
  const R = Math.max(2, num(radiusPx, 10));
  t = num(t);
  const s = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 23) * Math.sin(t * 7.1 + 1);
  const breathe = reduce ? 1 : 1 + 0.06 * Math.sin(t * 17.3) + 0.03 * Math.sin(t * 41);
  ctx.save();
  ctx.translate(num(x), num(y)); ctx.rotate(num(angle));
  const a0 = collarTex(0), a1 = collarTex(1);
  const w = 3 * R * breathe, h = 3.4 * R * (2 - breathe);
  const base = 0.85 * I * (reduce ? 1 : 0.8 + 0.2 * Math.sin(t * 29));
  if (a0) { ctx.globalAlpha = clamp01(base * (1 - s * 0.7)); ctx.drawImage(a0, -w / 2, -0.15 * R, w, h); }
  if (a1) { ctx.globalAlpha = clamp01(base * (0.3 + s * 0.7)); ctx.drawImage(a1, -w / 2, -0.15 * R, w, h); }
  ctx.restore();
}

const CHUTE_COLORS = { main: ['#f1ede4', '#d9572b'], drogue: ['#efebe2', '#c94a26'], dgb: ['#f3efe8', '#d8622a'] };

function canopy(ctx, R, H, skirtY, kind, cols, lx) {
  const topY = skirtY - H;
  // dome outline with scalloped skirt
  const G = kind === 'drogue' ? 6 : 10;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(-R, skirtY);
    ctx.bezierCurveTo(-R * 1.02, skirtY - H * 0.62, -R * 0.62, topY, 0, topY);
    ctx.bezierCurveTo(R * 0.62, topY, R * 1.02, skirtY - H * 0.62, R, skirtY);
    for (let g = G; g > 0; g--) {
      const a = Math.sin((-0.5 + g / G) * Math.PI) * R, b = Math.sin((-0.5 + (g - 1) / G) * Math.PI) * R;
      ctx.quadraticCurveTo((a + b) / 2, skirtY + R * 0.07, b, skirtY);
    }
    ctx.closePath();
  };
  // underside (inside of the canopy seen from below), darker
  ctx.fillStyle = 'rgba(70,58,50,0.85)';
  ctx.beginPath(); ctx.ellipse(0, skirtY, R * 0.97, Math.max(1, R * 0.14), 0, 0, Math.PI); ctx.fill();
  ctx.save();
  path(); ctx.clip();
  // gores: projected stripes (narrow toward the limbs, like a real sphere)
  const top = topY - 2, hh = H + R * 0.3;
  for (let g = 0; g < G; g++) {
    const x0 = Math.sin((-0.5 + g / G) * Math.PI) * R, x1 = Math.sin((-0.5 + (g + 1) / G) * Math.PI) * R;
    ctx.fillStyle = cols[g % cols.length];
    ctx.fillRect(x0 - 0.3, top, x1 - x0 + 0.6, hh);
  }
  if (kind === 'dgb') { // disk-gap-band: open gap ring shows the sky through
    const gy = skirtY - H * 0.38;
    ctx.fillStyle = 'rgba(30,24,22,0.55)';
    ctx.fillRect(-R - 1, gy - H * 0.05, R * 2 + 2, H * 0.09);
  }
  if (kind === 'drogue') { // ribbon canopy: horizontal gaps
    ctx.fillStyle = 'rgba(40,34,30,0.35)';
    for (let r = 1; r < 6; r++) ctx.fillRect(-R - 1, topY + (H * r) / 6, R * 2 + 2, Math.max(0.6, H * 0.04));
  }
  // shading: sun side lit, far side in shadow; top catches light; seams
  const sx = lx < 0 ? -1 : 1;
  const gr = ctx.createLinearGradient(sx * R, 0, -sx * R, 0);
  gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(0.45, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(18,20,34,0.42)');
  ctx.fillStyle = gr; ctx.fillRect(-R - 1, top, 2 * R + 2, hh);
  const gv = ctx.createLinearGradient(0, topY, 0, skirtY);
  gv.addColorStop(0, 'rgba(255,255,255,0.12)'); gv.addColorStop(0.7, 'rgba(0,0,0,0)'); gv.addColorStop(1, 'rgba(10,10,20,0.22)');
  ctx.fillStyle = gv; ctx.fillRect(-R - 1, top, 2 * R + 2, hh);
  ctx.strokeStyle = 'rgba(40,30,25,0.18)'; ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let g = 1; g < G; g++) {
    const x0 = Math.sin((-0.5 + g / G) * Math.PI) * R;
    ctx.moveTo(x0, skirtY + 1); ctx.quadraticCurveTo(x0 * 0.9, skirtY - H * 0.7, x0 * 0.15, topY + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** Canopies above the riser confluence point (x, y). */
export function drawParachutes(ctx, x, y, { count = 1, kind = 'main', deploy = 1, t = 0, pxPerM = 4, sway = 0, colors, light, reduce = false } = {}) {
  const k = clamp01(num(deploy));
  if (!ctx || !k) return;
  const n = Math.max(1, Math.min(6, count | 0));
  t = num(t);
  const ppm = Math.max(0.05, num(pxPerM, 4));
  const baseR = (kind === 'drogue' ? 3 : kind === 'dgb' ? 10.5 : 17) * ppm;
  // deployment: line stretch (streamer) → reefed → disreef to full
  const infl = k < 0.25 ? (k / 0.25) * 0.15 : k < 0.6 ? 0.15 + ((k - 0.25) / 0.35) * 0.35 : 0.5 + ((k - 0.6) / 0.4) * 0.5;
  const lineL = baseR * (kind === 'drogue' ? 3.6 : kind === 'dgb' ? 2.6 : 2.5) * (0.55 + 0.45 * Math.min(1, k * 3));
  const R0 = baseR * (0.12 + 0.88 * infl);
  const H0 = baseR * (0.92 + 0.6 * (1 - infl)) * (0.4 + 0.6 * Math.min(1, k * 2.5));
  const cols = colors || CHUTE_COLORS[kind] || CHUTE_COLORS.main;
  const lx = light ? num(light.ax, -0.6) : -0.6;
  const spread = n > 1 ? (kind === 'drogue' ? 0.3 : 0.44) : 0;
  ctx.save();
  ctx.translate(num(x), num(y));
  ctx.rotate(reduce ? 0 : num(sway) * 0.012 * Math.sin(t * 0.9));
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => Math.abs(b - (n - 1) / 2) - Math.abs(a - (n - 1) / 2)); // outer first, centre last
  for (const i of order) {
    const th = (i - (n - 1) / 2) * spread + (reduce ? 0 : 0.025 * Math.sin(t * 1.3 + i * 2.1));
    const br = reduce ? 1 : 1 + 0.035 * Math.sin(t * 2.3 + i * 1.7);
    const R = R0 * br, H = H0 / Math.sqrt(br);
    const L = lineL * (1 + 0.04 * Math.abs(i - (n - 1) / 2));
    ctx.save();
    ctx.rotate(th);
    // suspension lines converge on the riser
    ctx.strokeStyle = 'rgba(226,222,212,0.55)'; ctx.lineWidth = Math.max(0.4, ppm * 0.05);
    ctx.beginPath();
    const nl = 7;
    for (let j = 0; j <= nl; j++) { const sx = Math.sin((-0.5 + j / nl) * Math.PI) * R; ctx.moveTo(0, 0); ctx.lineTo(sx, -L); }
    ctx.stroke();
    if (k < 0.25) { // still a streamer: bagged canopy
      ctx.fillStyle = cols[0];
      ctx.beginPath(); ctx.ellipse(0, -L - H * 0.5, Math.max(1, R), H * 0.5, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(20,20,30,0.3)';
      ctx.beginPath(); ctx.ellipse(lx < 0 ? R * 0.3 : -R * 0.3, -L - H * 0.5, Math.max(0.5, R * 0.6), H * 0.5, 0, 0, TAU); ctx.fill();
    } else canopy(ctx, R, H, -L, kind, cols, lx);
    ctx.restore();
  }
  ctx.restore();
}

function plasmaTex(v) {
  return sprite(`plasma|${v}`, 160, 320, (d, W, H) => {
    const seed = 5150 + v * 37;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = (((x + 0.5) / W) * 2 - 1) * 3; // body radii
      const w = -2 + ((y + 0.5) / H) * 12; // front at -y, wake +y
      const ys = -1.32 + 0.3 * u * u; // bow shock
      const dd = w - ys;
      let h = 0;
      if (dd > -0.25) {
        h += 1.25 * Math.exp(-((dd / 0.22) ** 2)) * smooth(2.4, 0.6, Math.abs(u)) * (w < 1.2 ? 1 : smooth(3, 1.2, w)); // shock layer
        if (dd > 0) h += 0.85 * Math.exp(-dd * 1.15) * Math.exp(-(u * u) / 3.2); // hot sheath
      }
      if (w > -0.4) {
        const ww = Math.max(0, w);
        const width = 1.05 + 0.2 * ww;
        const st = fbm(u * 2.4 + v * 4, ww * 0.55 - v * 2, 4, seed);
        h += 0.85 * Math.exp(-((u / width) ** 2) * 1.6) * Math.exp(-ww / 4) * (0.45 + 1.0 * (st - 0.3)) * smooth(-0.4, 0.6, w);
      }
      h = Math.max(0, h) * smooth(3, 2.1, Math.abs(u)) * smooth(10, 6.5, w);
      let r, g, b;
      if (h < 0.35) { const f = h / 0.35; r = 150 + 90 * f; g = 30 + 60 * f; b = 120 - 60 * f; }
      else if (h < 0.75) { const f = (h - 0.35) / 0.4; r = 240 + 15 * f; g = 90 + 100 * f; b = 60 + 50 * f; }
      else { const f = Math.min(1, (h - 0.75) / 0.5); r = 255; g = 190 + 60 * f; b = 110 + 120 * f; }
      put(d, (y * W + x) * 4, r, g, b, clamp01(h * 0.95));
    }
  });
}

/** Plasma sheath around a body entering an atmosphere. angle = wake direction (0 = wake streams down). */
export function drawReentryPlasma(ctx, x, y, { intensity = 1, radiusPx = 20, angle = 0, t = 0, reduce = false } = {}) {
  const I = clamp01(num(intensity));
  if (!ctx || !(I > 0)) return;
  const r = Math.max(2, num(radiusPx, 20));
  t = num(t);
  ctx.save();
  ctx.translate(num(x), num(y)); ctx.rotate(num(angle));
  ctx.globalCompositeOperation = 'lighter';
  const s = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 13.7);
  const jit = reduce ? 1 : 1 + 0.05 * Math.sin(t * 37) + 0.04 * Math.sin(t * 59 + 1);
  const p0 = plasmaTex(0), p1 = plasmaTex(1);
  const wL = 12 * r * (0.55 + 0.45 * I) * jit;
  if (p0) { ctx.globalAlpha = clamp01(I * (1 - 0.6 * s)); ctx.drawImage(p0, -3 * r, -2 * r, 6 * r, wL); }
  if (p1) { ctx.globalAlpha = clamp01(I * (0.4 + 0.6 * s)); ctx.drawImage(p1, -3 * r, -2 * r, 6 * r, wL); }
  // envelope glow
  const gs = glowSprite([255, 150, 90], 'plasma');
  if (gs) { ctx.globalAlpha = clamp01(0.35 * I); ctx.drawImage(gs, -3.2 * r, -3 * r, 6.4 * r, 7 * r); }
  // ablation sparks shed into the wake (deterministic per time slice)
  if (!reduce && I > 0.3) {
    const R = rng((Math.floor(t * 12) * 2654435761) >>> 0);
    ctx.strokeStyle = 'rgba(255,200,140,0.9)'; ctx.lineWidth = Math.max(0.6, r * 0.05);
    ctx.globalAlpha = clamp01(I);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const px = (R() - 0.5) * 1.6 * r, py = (0.4 + R() * 2.6) * r, l = (0.15 + R() * 0.45) * r;
      ctx.moveTo(px, py); ctx.lineTo(px * 1.05, py + l);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawFlash(ctx, view, { color = '#fff', alpha = 0 } = {}) {
  if (!ctx || !view || !(alpha > 0)) return;
  ctx.save(); ctx.globalAlpha = Math.min(1, alpha); ctx.fillStyle = color; ctx.fillRect(-40, -40, num(view.W, 0) + 80, num(view.H, 0) + 80); ctx.restore();
}

// ------------------------------------------------------------------ particle system

const K = { smoke: 0, steam: 1, fire: 2, spark: 3, dust: 4, grain: 5, glow: 6, ring: 7, drop: 8, ember: 9, wave: 10, sheet: 11 };
const ADDITIVE = [false, false, true, true, false, false, true, true, false, true, false, false];
// alpha falloff exponent by kind (bigger = fades sooner)
const FADE = [1.25, 1.0, 1.2, 1.0, 1.1, 1.0, 1.6, 1.4, 0.8, 1.0, 1.2, 1.4];
const lightBucket = (l) => { const a = Math.atan2(num(l?.ay, -0.78), num(l?.ax, -0.62)); return ((Math.round((a / TAU) * 8) % 8) + 8) % 8; };

export function createFx({ cap = 600, seed = 1, reduce = false } = {}) {
  let R = rng(seed >>> 0);
  let red = !!reduce;
  let lb = lightBucket(null);
  const N = Math.max(16, cap | 0);
  // structure-of-arrays pool
  const px = new Float32Array(N), py = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
  const life = new Float32Array(N), max = new Float32Array(N), size = new Float32Array(N), grow = new Float32Array(N);
  const drag = new Float32Array(N), grav = new Float32Array(N), heat = new Float32Array(N), hk = new Float32Array(N);
  const alpha = new Float32Array(N), sq = new Float32Array(N), aux = new Float32Array(N);
  const kind = new Uint8Array(N), world = new Uint8Array(N), layer = new Uint8Array(N), pal = new Uint8Array(N), vari = new Uint8Array(N);
  let n = 0;
  let tokens = 0; // exhaust-smoke budget (particles), refilled in update(): many-engine clusters share it
  const debris = [];
  const capNow = () => (red ? Math.max(16, Math.round(N * 0.25)) : N);
  const rnd = (a = 0, b = 1) => a + (b - a) * R();
  const rate = (r) => r * (red ? 0.3 : 1);
  /** stochastic rounding of an expected count (deterministic through R) */
  const count = (expected, hi) => Math.min(hi, Math.floor(R() + Math.max(0, expected)));

  function spawn(x, y, vX, vY, k, o) {
    if (n >= capNow() || !Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const i = n++;
    px[i] = x; py[i] = y; vx[i] = num(vX); vy[i] = num(vY); life[i] = 0; max[i] = Math.max(0.05, o.m ?? 1);
    size[i] = Math.max(0.3, o.s ?? 3); grow[i] = o.gr ?? 0; drag[i] = o.dr ?? 0.6; grav[i] = o.g ?? 0;
    heat[i] = o.h ?? 0; hk[i] = o.hk ?? 2; alpha[i] = o.a ?? 0.6; sq[i] = o.sq ?? 1; aux[i] = 0;
    kind[i] = k; world[i] = o.w ?? 1; layer[i] = o.front ? 1 : 0; pal[i] = o.c ?? 0; vari[i] = o.v ?? ((R() * 4) | 0);
    return i;
  }
  function kill(i) {
    const j = --n;
    if (i === j) return;
    px[i] = px[j]; py[i] = py[j]; vx[i] = vx[j]; vy[i] = vy[j]; life[i] = life[j]; max[i] = max[j]; size[i] = size[j];
    grow[i] = grow[j]; drag[i] = drag[j]; grav[i] = grav[j]; heat[i] = heat[j]; hk[i] = hk[j]; alpha[i] = alpha[j]; sq[i] = sq[j];
    aux[i] = aux[j]; kind[i] = kind[j]; world[i] = world[j]; layer[i] = layer[j]; pal[i] = pal[j]; vari[i] = vari[j];
  }

  // ---------------------------------------------------------- drawing helpers
  function drawPuff(ctx, i, k01) {
    const s = size[i] + grow[i] * (1 - (1 - k01) * (1 - k01));
    const spr = puffSprite(pal[i], vari[i] & 3, lb);
    if (!spr) return s;
    const h = s * sq[i];
    ctx.drawImage(spr, px[i] - s, py[i] - h, s * 2, h * 2);
    return s;
  }
  function envelope(i, k01) {
    const fin = Math.min(1, k01 / 0.07);
    return alpha[i] * fin * Math.pow(1 - k01, FADE[kind[i]]);
  }

  const fx = {
    update(dt) {
      const d = Math.max(0, Math.min(0.1, Number(dt) || 0));
      if (!d) return;
      tokens = Math.min(8, tokens + d * (red ? 22 : 75));
      for (let i = n - 1; i >= 0; i--) {
        life[i] += d;
        if (life[i] >= max[i] || px[i] < -6000 || px[i] > 12000 || py[i] < -8000 || py[i] > 14000) { kill(i); continue; }
        const dr = Math.min(1, drag[i] * d);
        vx[i] -= vx[i] * dr; vy[i] -= vy[i] * dr; vy[i] += grav[i] * d;
        px[i] += vx[i] * d; py[i] += vy[i] * d;
        if (heat[i] > 0) heat[i] *= Math.exp(-hk[i] * d);
        if (kind[i] === K.ember && hk[i] > 0) { // burning debris sheds a smoke trail
          aux[i] += d;
          if (aux[i] > 0.028 && life[i] < max[i] * 0.85) {
            aux[i] = 0;
            spawn(px[i], py[i], vx[i] * 0.1, vy[i] * 0.1, K.smoke, { m: rnd(0.9, 1.8), s: size[i] * 1.4, gr: size[i] * 7, dr: 1.6, g: -8, c: P.xsmoke, a: 0.42, h: 0.9, hk: 4 });
          }
        }
      }
      for (let i = debris.length - 1; i >= 0; i--) {
        const o = debris[i];
        o.age += d;
        if (o.age >= o.life) { debris.splice(i, 1); continue; }
        o.vy += (o.gravity + o.ay) * d; o.vx += o.ax * d;
        const dr = Math.min(1, o.drag * d);
        o.vx -= o.vx * dr; o.vy -= o.vy * dr;
        o.x += o.vx * d; o.y += o.vy * d; o.rot += o.vr * d;
        if (o.tick) { try { o.tick(o, d, fx); } catch { o.tick = null; } }
        if (o.trail) {
          o.tacc += d;
          if (o.tacc > 0.06) {
            o.tacc = 0;
            const tr = o.trail;
            if (tr === 'fire') spawn(o.x, o.y, o.vx * 0.2, o.vy * 0.2, K.ember, { m: 0.5, s: 2.5, dr: 1, g: 0, a: 0.9, c: P.spark, front: false });
            else spawn(o.x, o.y, o.vx * 0.15, o.vy * 0.15, K.smoke, { m: rnd(1.2, 2.2), s: 2, gr: 12, dr: 1.2, g: -3, c: tr === 'vapor' ? P.vapor : P.kero_contrail, a: tr === 'vapor' ? 0.3 : 0.4 });
          }
        }
      }
    },

    draw(ctx, which = 'back') {
      if (!ctx) return;
      const L = which === 'front' ? 1 : 0;
      // visible bounds in local coords (cull off-screen particles)
      let x0 = -200, y0 = -200, x1 = 4000, y1 = 6000;
      try {
        const m = ctx.getTransform && ctx.getTransform();
        const cw = ctx.canvas?.width || 2000, ch = ctx.canvas?.height || 3000;
        if (m && m.a) { x0 = -m.e / m.a - 80; x1 = (cw - m.e) / m.a + 80; y0 = -m.f / m.d - 80; y1 = (ch - m.f) / m.d + 80; if (x1 < x0) { const t = x0; x0 = x1; x1 = t; } if (y1 < y0) { const t = y0; y0 = y1; y1 = t; } }
      } catch { /* keep defaults */ }
      ctx.save();
      if (L === 0) {
        for (const o of debris) {
          const k01 = o.age / o.life;
          const sc = Math.max(0.2, 1 - o.recede * o.age);
          ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot); if (sc !== 1) ctx.scale(sc, sc);
          ctx.globalAlpha = clamp01((o.life - o.age) / 1.5) * (1 - 0.3 * k01);
          try { o.paint(ctx); } catch { /* ignore */ }
          ctx.restore();
        }
      }
      // pass 1: lit / opaque media (smoke, steam, dust, droplets, grains)
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < n; i++) {
        const kd = kind[i];
        if (layer[i] !== L || ADDITIVE[kd]) continue;
        const k01 = life[i] / max[i];
        const s = size[i] + grow[i];
        if (px[i] + s < x0 || px[i] - s > x1 || py[i] + s < y0 || py[i] - s > y1) continue;
        const a = envelope(i, k01);
        if (a < 0.004) continue;
        ctx.globalAlpha = a > 1 ? 1 : a;
        if (kd === K.grain) {
          const c = PAL[pal[i]];
          ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.lineWidth = size[i];
          const sl = 0.03 * sq[i];
          ctx.beginPath(); ctx.moveTo(px[i], py[i]); ctx.lineTo(px[i] - vx[i] * sl, py[i] - vy[i] * sl); ctx.stroke();
        } else if (kd === K.drop) {
          const c = PAL[pal[i]];
          ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          const ss = size[i] * (1 - 0.4 * k01);
          ctx.fillRect(px[i] - ss / 2, py[i] - ss / 2, ss, ss * 1.6);
        } else if (kd === K.wave) {
          const ring = ringSprite();
          const ss = size[i] + grow[i] * (1 - (1 - k01) * (1 - k01));
          if (ring) ctx.drawImage(ring, px[i] - ss, py[i] - ss * sq[i], ss * 2, ss * 2 * sq[i]);
        } else if (kd === K.sheet) {
          const gsp = glowSprite(PAL[pal[i]], 'pal' + pal[i]);
          const ss = size[i] + grow[i] * (1 - (1 - k01) * (1 - k01) * (1 - k01));
          if (gsp) ctx.drawImage(gsp, px[i] - ss, py[i] - ss * sq[i] * 1.6, ss * 2, ss * 2 * sq[i]);
        } else drawPuff(ctx, i, k01);
      }
      // pass 2: light (fire, flashes, sparks, embers, fire-lit smoke)
      ctx.globalCompositeOperation = 'lighter';
      const heatSpr = glowSprite(PAL[P.heat], 'heat');
      for (let i = 0; i < n; i++) {
        if (layer[i] !== L) continue;
        const kd = kind[i];
        const k01 = life[i] / max[i];
        const s = size[i] + grow[i] * (1 - (1 - k01) * (1 - k01));
        if (px[i] + s < x0 || px[i] - s > x1 || py[i] + s < y0 || py[i] - s > y1) continue;
        if (!ADDITIVE[kd]) {
          if (heat[i] > 0.03 && heatSpr) { // smoke lit from inside by the flame
            ctx.globalAlpha = clamp01(heat[i] * envelope(i, k01) * 0.7);
            ctx.drawImage(heatSpr, px[i] - s * 0.9, py[i] - s * 0.9 * sq[i], s * 1.8, s * 1.8 * sq[i]);
          }
          continue;
        }
        const a = envelope(i, k01);
        if (a < 0.004) continue;
        ctx.globalAlpha = a > 1 ? 1 : a;
        if (kd === K.fire) {
          const step = Math.min(FIRE.length - 1, Math.floor(Math.pow(k01, 0.8) * FIRE.length));
          const spr = fireSprite(step, vari[i] & 1);
          if (spr) ctx.drawImage(spr, px[i] - s, py[i] - s * sq[i], s * 2, s * 2 * sq[i]);
        } else if (kd === K.glow) {
          const spr = glowSprite(PAL[pal[i]], 'pal' + pal[i]);
          if (spr) ctx.drawImage(spr, px[i] - s, py[i] - s * sq[i], s * 2, s * 2 * sq[i]);
        } else if (kd === K.ring) {
          const ring = ringSprite();
          if (ring) ctx.drawImage(ring, px[i] - s, py[i] - s * sq[i], s * 2, s * 2 * sq[i]);
        } else if (kd === K.spark) {
          const c = pal[i] === P.glint ? PAL[P.glint] : FIRE[Math.min(5, Math.floor(k01 * 4))];
          ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.lineWidth = size[i];
          ctx.beginPath(); ctx.moveTo(px[i], py[i]); ctx.lineTo(px[i] - vx[i] * 0.035, py[i] - vy[i] * 0.035); ctx.stroke();
        } else if (kd === K.ember) {
          const spr = fireSprite(Math.min(4, 1 + Math.floor(k01 * 4)), vari[i] & 1);
          const ss = size[i] * 1.6;
          if (spr) ctx.drawImage(spr, px[i] - ss, py[i] - ss, ss * 2, ss * 2);
        }
      }
      ctx.restore();
    },

    shift(dx, dy) {
      dx = num(dx); dy = num(dy);
      for (let i = 0; i < n; i++) if (world[i]) { px[i] += dx; py[i] += dy; }
      for (const o of debris) if (!o.rel) { o.x += dx; o.y += dy; }
    },
    clear() { n = 0; tokens = 0; debris.length = 0; R = rng(seed >>> 0); },
    count() { return n; },
    setReduce(b) { red = !!b; },
    /** Optional: sun direction for smoke-puff lighting ({ax, ay} screen space). */
    setLight(l) { if (l) lb = lightBucket(l); },

    /** Smoke / contrail trail from one nozzle. Spawns at the end of the visible plume. */
    exhaust(x, y, { angle = 0, prop = 'kerolox', pBar = 1, pxPerM = 4, dt = 0.016, rate: rt = 1, d = 3 } = {}) {
      const Pp = propOf(prop);
      const ex = expansionOf(pBar);
      if (ex > 0.86) return; // above ~45 km the exhaust no longer condenses into puffs (no cumulus at 70 km)
      const ppm = Math.max(0.05, num(pxPerM, 4));
      const dPx = Math.max(1, num(d, 3) * ppm);
      const g = plumeGeom(Pp, ex, dPx);
      const sa = Math.sin(num(angle)), ca = Math.cos(num(angle));
      const ex1 = 1 - ex;
      const cnt = Math.min(Math.floor(tokens), count(rate(Pp.smokeRate * Math.sqrt(Math.max(0.3, num(d, 3))) * num(rt, 1) * num(dt, 0.016)), 6));
      tokens -= cnt;
      for (let i = 0; i < cnt; i++) {
        const along = g.len * rnd(0.55, 0.95);
        const lat = rnd(-0.5, 0.5) * g.w * 0.5;
        const sx = num(x) - sa * along + ca * lat, sy = num(y) + ca * along + sa * lat;
        const sp = rnd(20, 80) * ex1 + rnd(40, 140) * ex;
        const la = rnd(-1, 1) * (12 + 40 * ex);
        const vX = -sa * sp + ca * la, vY = ca * sp + sa * la;
        const soot = Pp.soot && R() < Pp.soot;
        // big, densely overlapping puffs: they merge into one continuous column down to the pad cloud
        const big = Math.max(dPx * 1.9, 5);
        spawn(sx, sy, vX, vY, K.smoke, {
          m: (soot ? rnd(0.4, 0.8) : rnd(3, 5.5)) * (1 - 0.65 * ex),
          s: big * (soot ? rnd(0.5, 0.8) : rnd(0.9, 1.4)),
          gr: dPx * Pp.smokeGrow * rnd(0.8, 1.4) * (1 + 3 * ex),
          dr: 1.1, g: ex1 * rnd(-4, 2),
          c: soot ? P.soot : P[Pp.smoke2],
          a: Pp.smokeA * (soot ? 0.9 : 1) * (1 - 0.8 * ex),
          h: soot ? 0.9 : 0.55 * Pp.luminous * ex1, hk: soot ? 3 : 4,
        });
      }
    },

    /** Steam/smoke rolling sideways out of the flame trench + exhaust-lit ground. */
    padBillow(x, groundY, { intensity = 1, dt = 0.016, pxPerM = 4, deluge = true } = {}) {
      const I = clamp01(num(intensity, 1));
      if (!I) return;
      const ppm = Math.max(0.05, num(pxPerM, 4));
      x = num(x); groundY = num(groundY);
      // ground lit by the flame (short flickering flat glow)
      if (R() < 0.9) spawn(x + rnd(-2, 2) * ppm, groundY - ppm, 0, 0, K.glow, { m: rnd(0.1, 0.2), s: 30 * ppm * I, gr: 8 * ppm, dr: 0, c: P.heat, a: 0.22 * I, sq: 0.22, front: false });
      const cnt = count(rate(34 * I * num(dt, 0.016)), 8);
      for (let i = 0; i < cnt; i++) {
        const dir = R() < 0.56 ? 1 : -1; // trench exits favour one side
        const roll = R();
        if (roll < 0.72) { // sideways jet out of the trench, decelerating then rising
          spawn(x + dir * rnd(2, 10) * ppm, groundY - rnd(0.5, 4) * ppm, dir * rnd(22, 70) * ppm, -rnd(0, 6) * ppm, K.steam, {
            m: rnd(3.5, 7), s: rnd(5, 9) * ppm, gr: rnd(22, 40) * ppm, dr: 0.75, g: -rnd(0.3, 1.3) * ppm,
            c: deluge ? P.steam : P.solid, a: rnd(0.6, 0.9), h: rnd(0.5, 0.9), hk: rnd(2.5, 4),
          });
        } else { // turbulent column right under the vehicle
          spawn(x + rnd(-6, 6) * ppm, groundY - rnd(1, 6) * ppm, rnd(-8, 8) * ppm, -rnd(4, 14) * ppm, K.steam, {
            m: rnd(2.5, 5), s: rnd(6, 10) * ppm, gr: rnd(16, 30) * ppm, dr: 0.9, g: -rnd(0.5, 1.5) * ppm,
            c: deluge ? P.steam : P.kero_contrail, a: rnd(0.6, 0.85), h: 0.9, hk: 3,
          });
        }
      }
    },

    /** LOX boil-off: cold, dense vapour streaming downwind and sinking. */
    vent(x, y, { dir = 1, dt = 0.016, rate: rt = 1, ppm = 0 } = {}) {
      // sizes follow the world scale when ppm is given (so vents read the same in the pad window and full screen)
      const q = ppm > 0 ? Math.max(0.35, Math.min(2.5, ppm / 4)) : 1;
      // many small, faint puffs = a continuous wisp that leaves the valve fast, slows, drifts downwind and sinks
      const cnt = count(rate(52 * num(rt, 1) * num(dt, 0.016)), 5);
      for (let i = 0; i < cnt; i++) {
        spawn(num(x) + rnd(-0.6, 0.6) * q, num(y) + rnd(-0.6, 0.6) * q, num(dir, 1) * rnd(16, 34) * q, rnd(-3, 3) * q, K.steam, {
          m: rnd(1.5, 2.8), s: rnd(0.7, 1.3) * q, gr: rnd(6, 13) * q, dr: 1.3, g: rnd(5, 12) * q, c: P.lox, a: rnd(0.22, 0.4),
        });
      }
    },

    /** Sound-suppression deluge (from ~T-10 s): water sprayed across the deck, mist rolling off its edges. */
    deluge(x, groundY, { ppm = 4, dt = 0.016, intensity = 1, halfW = 12 } = {}) {
      const I = clamp01(num(intensity, 1));
      if (!I) return;
      const p = Math.max(0.2, num(ppm, 4));
      x = num(x); groundY = num(groundY);
      const nD = count(rate(60 * I * num(dt, 0.016)), 6);
      for (let i = 0; i < nD; i++) { // water jets arcing out of the rainbirds
        const side = R() < 0.5 ? -1 : 1;
        spawn(x + side * rnd(halfW * 0.6, halfW) * p, groundY - rnd(0, 1) * p, -side * rnd(4, 12) * p, -rnd(6, 12) * p, K.drop, { m: rnd(0.5, 0.9), s: Math.max(0.6, 0.25 * p), dr: 0.2, g: 22 * p, c: P.white, a: rnd(0.4, 0.7) });
      }
      const nM = count(rate(14 * I * num(dt, 0.016)), 3);
      for (let i = 0; i < nM; i++) { // spray mist hugging the deck
        spawn(x + rnd(-halfW, halfW) * p, groundY - rnd(0, 2) * p, rnd(-4, 4) * p, -rnd(0.5, 2) * p, K.steam, { m: rnd(1.5, 3), s: rnd(2, 4) * p, gr: rnd(6, 12) * p, dr: 0.8, g: -0.2 * p, c: P.steam, a: rnd(0.18, 0.32) * I });
      }
    },

    /** One small cold-gas puff (angle = direction the gas leaves). */
    rcs(x, y, angle = 0) {
      const c = Math.cos(num(angle)), s = Math.sin(num(angle));
      spawn(num(x), num(y), 0, 0, K.glow, { m: 0.08, s: 2, gr: 2, dr: 0, c: P.white, a: 0.5, front: true });
      for (let i = 0; i < (red ? 2 : 5); i++) {
        const sp = rnd(50, 110), spr = rnd(-0.35, 0.35);
        spawn(num(x), num(y), (c - s * spr) * sp, (s + c * spr) * sp, K.steam, { m: rnd(0.3, 0.55), s: 0.8, gr: rnd(4, 8), dr: 2.2, c: P.white, a: 0.55, front: true });
      }
    },

    /** Stage separation: pyro flash, cold-gas pushers, ullage motors, frozen-propellant flakes. */
    staging(x, y, { angle = 0, pxPerM = 4 } = {}) {
      const ppm = Math.max(0.05, num(pxPerM, 4));
      x = num(x); y = num(y);
      const sa = Math.sin(num(angle)), ca = Math.cos(num(angle));
      const ux = sa, uy = -ca; // vehicle "up"
      const qx = ca, qy = sa; // across
      spawn(x, y, 0, 0, K.glow, { m: 0.28, s: 3 * ppm, gr: 6 * ppm, dr: 0, c: P.flash, a: 0.9, front: true, sq: 0.6 });
      const nP = red ? 6 : 22;
      for (let i = 0; i < nP; i++) { // separation ring: gas jets out sideways in the sep plane
        const side = i % 2 ? 1 : -1, sp = rnd(18, 60) * ppm, back = rnd(-6, 14) * ppm;
        spawn(x + qx * side * rnd(0, 1.5) * ppm, y + qy * side * rnd(0, 1.5) * ppm, qx * side * sp - ux * back, qy * side * sp - uy * back, K.steam,
          { m: rnd(0.3, 0.65), s: ppm * rnd(0.5, 1), gr: ppm * rnd(10, 18), dr: 0.3, c: P.vapor, a: rnd(0.12, 0.26), front: true }); // vacuum: the gas flashes out and thins in a blink
      }
      for (let j = -1; j <= 1; j += 2) { // ullage motors on the upper stage, firing aft
        const bx = x + qx * j * 1.6 * ppm + ux * 2 * ppm, by = y + qy * j * 1.6 * ppm + uy * 2 * ppm;
        for (let i = 0; i < (red ? 2 : 6); i++) {
          const sp = rnd(30, 70) * ppm;
          spawn(bx, by, -ux * sp + qx * j * rnd(0, 6) * ppm, -uy * sp + qy * j * rnd(0, 6) * ppm, K.steam,
            { m: rnd(0.4, 0.8), s: ppm * 0.4, gr: ppm * rnd(1.5, 3), dr: 1.2, c: P.solid, a: 0.6, front: true, h: 0.6, hk: 6 });
        }
      }
      for (let i = 0; i < (red ? 2 : 8); i++) { // a few frozen LOX flakes catching the sun
        const a = rnd(0, TAU), sp = rnd(2, 14) * ppm;
        spawn(x + rnd(-1, 1) * ppm, y + rnd(-1, 1) * ppm, Math.cos(a) * sp - ux * 6 * ppm, Math.sin(a) * sp - uy * 6 * ppm, K.spark,
          { m: rnd(0.5, 1.1), s: rnd(0.5, 0.8), dr: 0.2, c: P.glint, a: rnd(0.3, 0.6), front: true });
      }
    },

    /** Fairing / LES jettison: pyro line flash, gas puffs out both sides, small fragments. */
    fairingPuff(x, y, { angle = 0, pxPerM = 4 } = {}) {
      const ppm = Math.max(0.05, num(pxPerM, 4));
      x = num(x); y = num(y);
      const sa = Math.sin(num(angle)), ca = Math.cos(num(angle));
      const qx = ca, qy = sa, ux = sa, uy = -ca;
      spawn(x, y, 0, 0, K.glow, { m: 0.18, s: 2 * ppm, gr: 3 * ppm, dr: 0, c: P.flash, a: 0.7, sq: 2.2, front: true });
      for (let i = 0; i < (red ? 4 : 16); i++) {
        const side = i % 2 ? 1 : -1, along = rnd(-3, 4) * ppm, sp = rnd(8, 26) * ppm;
        spawn(x + ux * along, y + uy * along, qx * side * sp, qy * side * sp, K.steam,
          { m: rnd(0.4, 1), s: ppm * 0.5, gr: ppm * rnd(4, 8), dr: 0.9, c: P.white, a: rnd(0.25, 0.5), front: true });
      }
      for (let i = 0; i < (red ? 3 : 12); i++) {
        const side = i % 2 ? 1 : -1, sp = rnd(10, 30) * ppm;
        spawn(x + ux * rnd(-3, 4) * ppm, y + uy * rnd(-3, 4) * ppm, qx * side * sp, qy * side * sp + rnd(-5, 5) * ppm, K.spark,
          { m: rnd(0.6, 1.4), s: 0.8, dr: 0.3, c: P.glint, a: 0.7, front: true });
      }
    },

    /** Plume/ground interaction during landing. Airless: ballistic radial sheets; atmosphere: billowing dust. */
    landingDust(x, groundY, { intensity = 1, world: wd = 'moon', pxPerM = 4, dt = 0.016 } = {}) {
      const I = clamp01(num(intensity, 1));
      if (!I) return;
      const ppm = Math.max(0.05, num(pxPerM, 4));
      x = num(x); groundY = num(groundY);
      const atm = ATMOS.has(wd);
      const gpx = (GRAVITY[wd] ?? 1.6) * ppm;
      const c = DUST_PAL[wd] ?? P.rock;
      const D = Math.min(0.5, num(dt, 0.016));
      if (!atm) {
        // radial sheet: a flat haze racing outward along the surface (Apollo footage), never billowing
        // (sheets are sized in screen px with a floor so a big, distant ship still shows a readable fan)
        const sw = Math.max(ppm * 2, 6);
        if (R() < 0.7 * Math.sqrt(I) + D) spawn(x, groundY - 0.3 * ppm, 0, 0, K.sheet, { m: rnd(0.35, 0.7), s: sw, gr: Math.min(rnd(12, 22) * Math.max(ppm, 3), 420) * (0.35 + 0.65 * I), dr: 0, c, a: Math.min(0.5, 0.2 + 0.35 * I), sq: 0.1, w: 0 });
        const cnt = count(rate(420 * Math.sqrt(I) * D), 60);
        for (let i = 0; i < cnt; i++) {
          const dir = R() < 0.5 ? -1 : 1;
          const el = rnd(0.01, 0.14) * (0.6 + 0.4 * I); // low elevation angle: flat, fast, straight streaks
          const sp = Math.min(1100, rnd(60, 220) * Math.max(ppm, 3) * (0.5 + I));
          spawn(x + dir * rnd(0.2, 3) * Math.max(ppm, 2), groundY - rnd(0, 0.4) * ppm, dir * sp * Math.cos(el), -sp * Math.sin(el), K.grain,
            { m: rnd(0.4, 1.1), s: rnd(0.6, 1.5), dr: 0, g: gpx, c, a: rnd(0.5, 0.95) * Math.sqrt(I), w: 0, sq: 2.2 });
        }
      } else {
        const thick = wd === 'titan' ? 0.6 : 1;
        const cnt = count(rate(60 * I * D), 14);
        for (let i = 0; i < cnt; i++) {
          const dir = R() < 0.5 ? -1 : 1;
          spawn(x + dir * rnd(0.5, 4) * ppm, groundY - rnd(0, 1.5) * ppm, dir * rnd(8, 30) * ppm * thick, -rnd(0.5, 5) * ppm * thick, K.dust,
            { m: rnd(3, 6.5), s: rnd(1.5, 3) * ppm, gr: rnd(8, 16) * ppm, dr: 1.1, g: -rnd(0.1, 0.6) * ppm, c, a: rnd(0.45, 0.75) * I, w: 0 });
        }
        const cg = count(rate(40 * I * D), 10);
        for (let i = 0; i < cg; i++) {
          const dir = R() < 0.5 ? -1 : 1, sp = rnd(30, 90) * ppm;
          spawn(x + dir * rnd(0.3, 2) * ppm, groundY, dir * sp, -rnd(3, 15) * ppm, K.grain, { m: rnd(0.4, 0.9), s: rnd(0.5, 1), dr: 1.5, g: gpx, c, a: 0.5 * I, w: 0 });
        }
      }
    },

    /** Fireball + lit smoke + burning debris with trails + shockwave ring (atmosphere). */
    explosion(x, y, { scale = 1, world: wd = 'earth', dir = null } = {}) {
      const s = Math.max(0.1, num(scale, 1));
      const atm = ATMOS.has(wd) || wd == null;
      x = num(x); y = num(y);
      const m = red ? 0.3 : 1;
      spawn(x, y, 0, 0, K.glow, { m: 0.22, s: 22 * s, gr: 70 * s, dr: 0, c: P.flash, a: 0.9, front: true }); // brief flash, not a disc
      // fireball: 4-6 billowing lobes thrown out along the vehicle's momentum and sideways, each a cluster of
      // turbulent fire puffs of staggered size and speed (cauliflower edge), with a few cool sooty pockets
      const nl = 4 + ((R() * 3) | 0);
      const lobes = [];
      for (let i = 0; i < nl; i++) lobes.push({ a: dir != null && i < 2 ? num(dir) + rnd(-0.5, 0.5) : rnd(0, TAU), v: rnd(60, 170) * s, r: rnd(0.7, 1.3) });
      for (const lb2 of lobes) {
        for (let j = 0; j < Math.round(9 * m); j++) {
          const a = lb2.a + rnd(-0.32, 0.32), v = lb2.v * rnd(0.35, 1.05);
          spawn(x + Math.cos(a) * rnd(0, 6) * s, y + Math.sin(a) * rnd(0, 6) * s, Math.cos(a) * v, Math.sin(a) * v, K.fire,
            { m: rnd(0.7, 1.9), s: rnd(6, 16) * s * lb2.r, gr: rnd(18, 46) * s * lb2.r, dr: atm ? 2.4 : 0.4, g: atm ? -rnd(10, 40) * s : 0, a: rnd(0.4, 0.75), front: true });
        }
        if (atm) for (let j = 0; j < Math.round(3 * m); j++) { // dark soot pockets inside the lobe
          const a = lb2.a + rnd(-0.4, 0.4), v = lb2.v * rnd(0.3, 0.8);
          spawn(x, y, Math.cos(a) * v, Math.sin(a) * v, K.smoke, { m: rnd(1.2, 2.4), s: rnd(6, 12) * s, gr: rnd(30, 60) * s, dr: 2, g: -rnd(4, 14) * s, c: P.xsmoke, a: 0.55, h: 0.8, hk: 2.5, front: true });
        }
      }
      for (let i = 0; i < Math.round(30 * m); i++) { // smoke, lit from inside, rising
        const a = rnd(0, TAU), v = rnd(15, 110) * s;
        spawn(x, y, Math.cos(a) * v, Math.sin(a) * v, K.smoke, atm
          ? { m: rnd(3, 6.5), s: rnd(12, 20) * s, gr: rnd(60, 120) * s, dr: 1.3, g: -rnd(6, 20) * s, c: P.xsmoke, a: rnd(0.6, 0.85), h: 1, hk: rnd(0.7, 1.2) }
          : { m: rnd(1.2, 2.2), s: rnd(8, 14) * s, gr: rnd(80, 140) * s, dr: 0, c: P.xsmoke, a: 0.35, h: 0.8, hk: 2 });
      }
      // burning chunks: momentum carries most of them along the flight direction; uneven speeds, sizes and drag;
      // about half are bare tumbling fragments with no smoke trail
      const gauss = () => (R() + R() + R() - 1.5) / 1.5;
      for (let i = 0; i < Math.round(14 * m); i++) {
        const a = dir != null ? num(dir) + gauss() * 1.4 : rnd(0, TAU), v = (dir != null ? rnd(60, 360) : rnd(110, 320)) * s * (0.5 + R());
        const trail = R() < 0.5;
        spawn(x + rnd(-6, 6) * s, y + rnd(-6, 6) * s, Math.cos(a) * v, Math.sin(a) * v - (atm ? 40 * s : 0), K.ember, { m: rnd(1.2, 3.2), s: rnd(1.2, 3.6) * s, dr: atm ? rnd(0.15, 0.9) : 0, g: atm ? 110 * s : 0, a: 1, front: true, hk: trail ? 2 : 0 });
      }
      for (let i = 0; i < Math.round(40 * m); i++) { // sparks
        const a = rnd(0, TAU), v = rnd(150, 460) * s;
        spawn(x, y, Math.cos(a) * v, Math.sin(a) * v, K.spark, { m: rnd(0.35, 1.1), s: rnd(0.8, 1.8), dr: atm ? 0.8 : 0, g: atm ? 140 : 0, a: 1, front: true });
      }
      if (atm) spawn(x, y, 0, 0, K.ring, { m: 0.6, s: 10 * s, gr: 280 * s, dr: 0, c: P.white, a: 0.32, front: true });
    },

    /** Splashdown: droplet crown, mist and ring waves on the surface. */
    splash(x, waterY, { scale = 1 } = {}) {
      const s = Math.max(0.1, num(scale, 1));
      x = num(x); waterY = num(waterY);
      const m = red ? 0.3 : 1;
      for (let i = 0; i < Math.round(90 * m); i++) {
        const dir = R() < 0.5 ? -1 : 1;
        spawn(x + dir * rnd(2, 14) * s, waterY, dir * rnd(15, 110) * s, -rnd(60, 240) * s, K.drop, { m: rnd(0.7, 1.5), s: rnd(0.8, 2) * s, dr: 0.3, g: 320, c: P.white, a: 0.9, w: 0, front: true });
      }
      for (let i = 0; i < Math.round(26 * m); i++) {
        const dir = R() < 0.5 ? -1 : 1;
        spawn(x + dir * rnd(0, 22) * s, waterY - rnd(0, 10) * s, dir * rnd(10, 70) * s, -rnd(15, 70) * s, K.steam, { m: rnd(1.2, 2.6), s: rnd(2.5, 5) * s, gr: rnd(14, 30) * s, dr: 1.4, g: 6, c: P.white, a: rnd(0.22, 0.42), w: 0, front: true });
      }
      for (let i = 0; i < 3; i++) spawn(x, waterY + 1, 0, 0, K.wave, { m: 2.5 + i, s: 6 * s, gr: (70 + i * 45) * s, dr: 0, c: P.white, a: 0.5 - i * 0.1, sq: 0.18, w: 0 });
    },

    /**
     * Separated hardware. ax/ay = extra acceleration (px/s², e.g. the relative acceleration of the still-thrusting
     * vehicle, along its axis); rel = true: position is relative to the tracked vehicle, not shifted with the
     * world by shift(); tick(o, dt, fx) runs every update (puffs, spin-up, fin deployment).
     */
    addDebris({ paint, x = 0, y = 0, vx: dvx = 0, vy: dvy = 0, rot = 0, vr = 0, life: lf = 6, gravity = 60, drag: dg = 0.1, trail = null, recede = 0.04, ax = 0, ay = 0, rel = false, tick = null } = {}) {
      if (typeof paint !== 'function') return null;
      if (debris.length > 24) debris.shift();
      const o = { paint, x: num(x), y: num(y), vx: num(dvx), vy: num(dvy), rot: num(rot), vr: num(vr), life: Math.max(0.1, num(lf, 6)), age: 0, gravity: num(gravity, 60), drag: num(dg, 0.1), trail: trail === true ? 'smoke' : trail, tacc: 0, recede: Math.max(0, num(recede, 0.04)), ax: num(ax), ay: num(ay), rel: !!rel, tick: typeof tick === 'function' ? tick : null };
      debris.push(o);
      return o;
    },

    /** Booster separation motor / cold-gas jet: a bright short-lived jet (angle = direction the gas leaves) + grey smoke. */
    jet(x, y, angle = 0, { ppm = 2, hot = true, len = 1 } = {}) {
      x = num(x); y = num(y);
      const c = Math.cos(num(angle)), s = Math.sin(num(angle)), p = Math.max(0.3, num(ppm, 2));
      if (hot) spawn(x, y, c * 8 * p, s * 8 * p, K.glow, { m: rnd(0.12, 0.22), s: 1.2 * p, gr: 2.5 * p * len, dr: 0, c: P.flash, a: 0.95, front: true, sq: 0.7 });
      for (let i = 0; i < (red ? 2 : 6); i++) {
        const sp = rnd(18, 40) * p * len, sw = rnd(-0.25, 0.25);
        spawn(x, y, (c - s * sw) * sp, (s + c * sw) * sp, K.steam, { m: rnd(0.6, 1.4), s: 0.8 * p, gr: rnd(5, 10) * p * len, dr: 1.6, c: hot ? P.solid : P.white, a: hot ? rnd(0.5, 0.75) : rnd(0.35, 0.55), front: true, h: hot ? 0.7 : 0, hk: 5 });
      }
    },
    debrisCount() { return debris.length; },
  };
  return fx;
}

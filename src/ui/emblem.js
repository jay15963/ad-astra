// Agency emblems (docs/EXPANSION.md §5.4): a procedural, layered SVG insignia — shape, field + division, orbit
// swooshes, a central charge (glyph), stars, a ring or a ribbon with the motto and the label. Pure string output, no
// DOM: usable in Node tests. Never copies an official logo; real lineages get original specs (data/core/emblems.json),
// procedural actors draw from their archetype grammar seeded by hash32(id).
//
// spec = { shape, field, field2?, division, ring?: {color, text?}, glyph, glyphColor, accent?, orbit?: 0..2,
//          stars: 0..12, label, seed? }   (JSON ≤ 200 B)
//
// Level of detail by size: < 44 px only shape, field, glyph and orbit (no text); 44–71 px adds stars and the label on
// the ribbon; ≥ 72 px adds the ring text / motto.

import { hash32 } from '../core/rng.js';

export const SHAPES = ['roundel', 'shield', 'hex', 'chevron', 'wing', 'star', 'wordmark'];
export const DIVISIONS = ['none', 'half', 'band', 'chevron', 'quarter'];
export const BASE_GLYPHS = ['rocket', 'orbit', 'star', 'planet', 'comet', 'capsule', 'atom', 'globe', 'wreath'];
export const MAX_SPEC_BYTES = 200;
export const MAX_RING_TEXT = 22;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT = "Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

/** Fallback palettes when data/core/emblem-parts.json is not registered: [field, field2, glyph, accent]. */
const DEFAULT_PALETTES = [
  ['#13294b', '#1f3d6e', '#f2f4f7', '#d6453d'], ['#0e1a2b', '#23395b', '#e8d5a3', '#e3b341'],
  ['#9e1b1b', '#7a1414', '#f2c14e', '#f2c14e'], ['#0b5d4b', '#08473a', '#f5f1e6', '#e9b44c'],
  ['#1f6fb2', '#175a92', '#ffffff', '#f2c14e'], ['#1d1f24', '#2b2e35', '#e6e8ec', '#3fa7d6'],
  ['#0b4f6c', '#083b52', '#eaf6fb', '#f4a259'], ['#5e1f2d', '#44141f', '#f0dcc0', '#d4a24c'],
  ['#2d1e4f', '#3e2a6b', '#9ad1d4', '#f28c28'], ['#8c3b1f', '#6b2c17', '#f7e3c6', '#f2b544'],
];
const DEFAULT_GRAMMAR = {
  agency: { shapes: ['roundel', 'roundel', 'shield', 'star', 'hex'], glyphs: ['rocket', 'orbit', 'globe', 'star', 'planet'], divisions: ['none', 'none', 'band', 'half', 'chevron'], ring: 0.7, stars: [0, 7], orbit: [0, 2] },
  company: { shapes: ['wordmark', 'wordmark', 'hex', 'chevron', 'wing'], glyphs: ['rocket', 'comet', 'orbit', 'atom', 'capsule'], divisions: ['none', 'chevron', 'band'], ring: 0.2, stars: [0, 2], orbit: [0, 2] },
};

// ------------------------------------------------------------------ registered data (UI-side, optional)

const REG = { parts: null, book: null, fetching: false };
const CACHE = new Map();
const CACHE_CAP = 400;

/**
 * Register data/core/emblem-parts.json and data/core/emblems.json (pass the loaded `data`, or {emblemParts, emblems}).
 * Safe to call many times; clears the render cache when something changed.
 */
export function useEmblemData(data) {
  if (!data || typeof data !== 'object') return false;
  let changed = false;
  if (data.emblemParts && data.emblemParts !== REG.parts) { REG.parts = data.emblemParts; changed = true; }
  if (data.emblems && data.emblems !== REG.book) { REG.book = data.emblems; changed = true; }
  if (changed) CACHE.clear();
  return changed;
}

/** Browser fallback: fetch the two files once if nobody registered them (same-origin static files, precached). */
function lazyLoad() {
  if (REG.fetching || (REG.parts && REG.book) || typeof fetch !== 'function' || typeof document === 'undefined') return;
  REG.fetching = true;
  const get = (name) => fetch(new URL(`../../data/core/${name}.json`, import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([REG.parts ? null : get('emblem-parts'), REG.book ? null : get('emblems')]).then(([parts, book]) => {
    const changed = useEmblemData({ emblemParts: REG.parts || parts || undefined, emblems: REG.book || book || undefined });
    if (changed) { try { window.dispatchEvent(new CustomEvent('adastra:emblems')); } catch { /* old browser */ } }
  });
}

export const emblemData = () => ({ parts: REG.parts, book: REG.book });

/** Palettes [{id, name, colors:[field, field2, glyph, accent]}]. */
export function palettes(parts = REG.parts) {
  const list = Array.isArray(parts?.palettes) ? parts.palettes.filter((p) => Array.isArray(p?.colors) && p.colors.length >= 4 && p.colors.every((c) => HEX.test(c))) : [];
  return list.length ? list : DEFAULT_PALETTES.map((colors, i) => ({ id: `p${i}`, name: `Paleta ${i + 1}`, colors }));
}

/** Glyph ids available (base + extra paths from emblem-parts.json). */
export function glyphIds(parts = REG.parts) {
  const extra = Object.keys(parts?.paths || {}).filter((k) => /^[a-z_]{2,16}$/.test(k));
  return [...BASE_GLYPHS, ...extra.filter((k) => !BASE_GLYPHS.includes(k))];
}

/** [{id, name}] lists for the editor (pt-BR names from emblem-parts.json when registered). */
export function partOptions(kind, parts = REG.parts) {
  const ids = kind === 'shapes' ? SHAPES : kind === 'divisions' ? DIVISIONS : glyphIds(parts);
  const names = Object.fromEntries((parts?.[kind] || []).map((x) => [x.id, x.name]));
  return ids.map((id) => ({ id, name: names[id] || id }));
}

// ------------------------------------------------------------------ colour helpers

function rgb(hex) {
  let x = String(hex).replace('#', '');
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
}
const toHex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** Mix toward black (t < 0) or white (t > 0). */
export function shade(hex, t) {
  const c = rgb(hex);
  return toHex(c.map((v) => (t < 0 ? v * (1 + t) : v + (255 - v) * t)));
}
export function luminance(hex) {
  const ch = rgb(hex).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
export const LIGHT_INK = '#f7f1e3';
export const DARK_INK = '#14202e';
/** Ink that reads best on a fill (light or dark). */
export function inkFor(fill) {
  try { return contrast(fill, DARK_INK) > contrast(fill, LIGHT_INK) ? DARK_INK : LIGHT_INK; } catch { return LIGHT_INK; }
}
const dist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
/** Colour that stands out on `bg`: `want` if it contrasts enough, else the ink for bg. */
const readable = (want, bg, min = 2.2) => (HEX.test(want || '') && contrast(want, bg) >= min ? want : inkFor(bg));

// ------------------------------------------------------------------ spec normalization

const clean = (s, max) => String(s ?? '').replace(/[<>&"'`\\{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const pickIn = (v, list, dflt) => (list.includes(v) ? v : dflt);
const int = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const color = (v, dflt) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : dflt);

/** Up to 6 characters for a label (uppercase; letters, digits, '-', 'ª', '.'). */
export function cleanLabel(s) {
  return clean(s, 24).toUpperCase().replace(/[^\p{L}\p{N}ª.\- ]/gu, '').replace(/\s+/g, '').slice(0, 6);
}

/**
 * Complete, safe spec (every field present and valid). Unknown glyphs fall back to 'star'; colours must be #rgb or
 * #rrggbb; texts are stripped of markup. Pure.
 */
export function normalizeSpec(spec, { label, parts = REG.parts } = {}) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const field = color(s.field, '#13294b');
  const field2 = color(s.field2, shade(field, -0.22));
  const glyphs = glyphIds(parts);
  const glyphColor = color(s.glyphColor, inkFor(field));
  const out = {
    shape: pickIn(s.shape, SHAPES, 'roundel'),
    field, field2,
    division: pickIn(s.division, DIVISIONS, 'none'),
    glyph: pickIn(s.glyph, glyphs, 'star'),
    glyphColor,
    accent: color(s.accent, readable(s.field2, field, 2.6) === s.field2 ? field2 : glyphColor),
    orbit: int(s.orbit, 0, 2, 0),
    stars: int(s.stars, 0, 12, 0),
    label: cleanLabel(s.label ?? label ?? '') || '',
    ring: null,
  };
  if (s.ring && typeof s.ring === 'object') out.ring = { color: color(s.ring.color, shade(field, -0.35)), text: clean(s.ring.text, MAX_RING_TEXT).toUpperCase() };
  return out;
}

/** Compact JSON of a spec (drops defaults) — what agency/found stores. */
export function compactSpec(spec) {
  const n = normalizeSpec(spec);
  const o = { shape: n.shape, field: n.field };
  if (n.field2 !== shade(n.field, -0.22)) o.field2 = n.field2;
  if (n.division !== 'none') o.division = n.division;
  if (n.ring) o.ring = n.ring.text ? { color: n.ring.color, text: n.ring.text } : { color: n.ring.color };
  o.glyph = n.glyph;
  o.glyphColor = n.glyphColor;
  o.accent = n.accent;
  if (n.orbit) o.orbit = n.orbit;
  if (n.stars) o.stars = n.stars;
  if (n.label) o.label = n.label;
  // keep the stored spec ≤ 200 B: shorten the motto first
  while (o.ring?.text && JSON.stringify(o).length > MAX_SPEC_BYTES) o.ring.text = o.ring.text.slice(0, -1).trim();
  if (o.ring && !o.ring.text) delete o.ring.text;
  // still too big (long colours + every option): drop what has a sensible default
  for (const k of ['accent', 'field2', 'glyphColor']) if (JSON.stringify(o).length > MAX_SPEC_BYTES) delete o[k];
  return o;
}

export const specBytes = (spec) => JSON.stringify(spec ?? null).length;

// ------------------------------------------------------------------ procedural specs

const PICK = (h, list) => list[h % list.length];

/**
 * Deterministic spec from a seed: archetype/kind grammar, a palette close to `color` when given, era shape bias.
 * opts: {kind, color, label, era, motto}
 */
export function specFromSeed(seed, { kind = 'agency', color: want, label = '', era, motto } = {}, parts = REG.parts) {
  const k = String(seed ?? 'x');
  const hh = (tag) => hash32(k, 'emblem', tag);
  const gram = parts?.grammar?.[kind] || DEFAULT_GRAMMAR[kind] || parts?.grammar?.agency || DEFAULT_GRAMMAR.agency;
  const pals = palettes(parts);
  let pal;
  if (HEX.test(want || '')) {
    // the 3 closest palettes to the actor's colour (by field or field2), then the seed picks one
    const ranked = pals.map((p) => ({ p, d: Math.min(dist(p.colors[0], want), dist(p.colors[1], want) * 1.15) })).sort((a, b) => a.d - b.d).slice(0, 3);
    pal = ranked[hh('pal') % ranked.length].p.colors;
  } else pal = PICK(hh('pal'), pals).colors;
  const eraShapes = era && Array.isArray(parts?.eraStyle?.[era]) ? parts.eraStyle[era].filter((s) => gram.shapes.includes(s)) : [];
  const shapePool = eraShapes.length && hh('era') % 2 ? eraShapes : gram.shapes;
  const glyphs = (gram.glyphs || BASE_GLYPHS).filter((g) => glyphIds(parts).includes(g));
  const [s0, s1] = gram.stars || [0, 5];
  const [o0, o1] = gram.orbit || [0, 1];
  const shape = PICK(hh('shape'), shapePool);
  const spec = {
    shape, field: pal[0], field2: pal[1], division: PICK(hh('div'), gram.divisions || ['none']),
    glyph: PICK(hh('glyph'), glyphs.length ? glyphs : BASE_GLYPHS), glyphColor: pal[2], accent: pal[3],
    orbit: o0 + (hh('orbit') % (o1 - o0 + 1)), stars: s0 + (hh('stars') % (s1 - s0 + 1)), label: cleanLabel(label),
  };
  if ((hh('ring') % 1000) / 1000 < (gram.ring ?? 0.5) || motto) {
    spec.ring = { color: shade(pal[0], -0.38), text: clean(motto || '', MAX_RING_TEXT).toUpperCase() };
    if (luminance(pal[0]) > 0.45) spec.ring.color = pal[1];
  }
  if (spec.shape === 'wordmark') spec.stars = Math.min(spec.stars, 3);
  return normalizeSpec(spec, { parts });
}

/** Up to 6 letters for an actor's emblem: explicit label, short when it fits, else a word-aware abbreviation. */
export function labelFor(actor) {
  if (typeof actor?.emblem === 'string') return cleanLabel(actor.emblem);
  if (actor?.emblem?.label) return cleanLabel(actor.emblem.label);
  const base = String(actor?.short || actor?.name || actor?.id || '?').replace(/\(.*?\)/g, '').trim() || '?';
  const up = base.toUpperCase();
  if (up.length <= 6) return cleanLabel(up) || '?';
  const words = up.split(/[\s-]+/).filter(Boolean);
  if (words.length > 1) return cleanLabel(words[0].length <= 6 ? words[0] : words.map((w) => w[0]).join('')) || '?';
  return cleanLabel(up.slice(0, 4)) || '?';
}

/** Book entry for a lineage: the identity's spec (by identityIdx, else by matching label, else the latest). */
function bookSpec(actor, book) {
  const specs = book?.specs || book;
  const id = actor?.lineage || actor?.id;
  const list = id && specs && typeof specs === 'object' ? specs[id] : null;
  if (!Array.isArray(list) || !list.length) return null;
  const idx = Number(actor.identityIdx);
  if (Number.isInteger(idx) && idx >= 0 && idx < 100) return list[Math.min(idx, list.length - 1)] || null;
  const lab = labelFor({ ...actor, emblem: undefined });
  return list.find((s) => s && cleanLabel(s.label) === lab) || list[list.length - 1];
}

/**
 * The spec to draw for an actor-like object ({id, short, name, color, kind, emblem, lineage, identityIdx, archetype}):
 * its own spec object > the lineage book (data/core/emblems.json) > procedural from hash32(id).
 * Objects without an id (old callers passing only {short, color}) get a wordmark in their colour.
 */
export function specForActor(actor, { book = REG.book, parts = REG.parts } = {}) {
  if (!REG.book && book === REG.book) lazyLoad();
  const a = actor && typeof actor === 'object' ? actor : { id: String(actor ?? '?') };
  const label = labelFor(a);
  const own = a.emblem && typeof a.emblem === 'object' ? a.emblem : null;
  if (own && own.shape) {
    const extra = {};
    // stored procedural specs (lifecycle genActor) carry a seed: derive the optional parts they leave out
    if (own.seed != null) {
      const h = hash32(String(own.seed), 'emblem-extra');
      if (own.orbit == null) extra.orbit = h % 3 === 0 ? 0 : 1 + (h % 2);
      if (own.accent == null && own.field2) extra.accent = own.field2;
      if (own.ring == null && (own.shape === 'roundel' || h % 4 === 0)) extra.ring = { color: shade(own.field || '#13294b', -0.38) };
    }
    return normalizeSpec({ ...own, ...extra, label: own.label || label }, { parts });
  }
  const fromBook = bookSpec(a, book);
  if (fromBook) return normalizeSpec({ ...fromBook, label: a.identityIdx >= 100 ? label : (fromBook.label || label) }, { parts });
  if (!a.id) {
    const field = color(a.color, '#28628f');
    return normalizeSpec({ shape: 'wordmark', field, glyph: 'orbit', glyphColor: inkFor(field), accent: inkFor(field), orbit: 1, label }, { parts });
  }
  const kind = a.kind === 'company' ? 'company' : a.kind === 'consortium' || a.kind === 'colony' || a.kind === 'order' ? a.kind : (a.holderKind ? 'investor' : 'agency');
  return specFromSeed(a.id, { kind, color: a.color, label }, parts);
}

// ------------------------------------------------------------------ geometry

const f1 = (n) => (Math.round(n * 10) / 10).toString();
function polar(cx, cy, r, deg) { const a = (deg * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
function starPath(cx, cy, R, r = R * 0.42, n = 5, rot = -90) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const [x, y] = polar(cx, cy, i % 2 ? r : R, rot + (i * 180) / n);
    d += `${i ? 'L' : 'M'}${f1(x)} ${f1(y)}`;
  }
  return `${d}Z`;
}

/** Outline path (100×100 box) of each shape. */
const OUTLINE = {
  roundel: 'M3 50a47 47 0 1 0 94 0a47 47 0 1 0-94 0Z',
  shield: 'M50 4L88 12Q89 30 89 46Q89 72 50 96Q11 72 11 46Q11 30 12 12Z',
  hex: 'M50 3L90.7 26.5V73.5L50 97L9.3 73.5V26.5Z',
  chevron: 'M11 7H89Q94 7 94 12V57L50 96L6 57V12Q6 7 11 7Z',
  wing: 'M22 46a28 28 0 1 0 56 0a28 28 0 1 0-56 0Z',
  star: starPath(50, 50, 48, 37, 8, -90),
  wordmark: 'M14 18H86Q96 18 96 28V72Q96 82 86 82H14Q4 82 4 72V28Q4 18 14 18Z',
};

/** Where the charge sits per shape: [cx, cy, scale] for full/mid detail and for small. */
const CHARGE = {
  roundel: { ring: [50, 50, 0.5], plain: [50, 44, 0.52], small: [50, 50, 0.64] },
  shield: { full: [50, 42, 0.5], small: [50, 47, 0.6] },
  hex: { full: [50, 44, 0.52], small: [50, 50, 0.62] },
  chevron: { full: [50, 38, 0.48], small: [50, 42, 0.56] },
  wing: { full: [50, 46, 0.4], small: [50, 46, 0.46] },
  star: { full: [50, 46, 0.46], small: [50, 50, 0.54] },
  wordmark: { full: [50, 33, 0.24], small: [50, 33, 0.22] },
};

/** Division layer (drawn inside the shape clip). */
function divisionLayer(div, c2) {
  switch (div) {
    case 'half': return `<rect x="50" y="0" width="50" height="100" fill="${c2}"/>`;
    case 'band': return `<rect x="0" y="39" width="100" height="22" fill="${c2}"/>`;
    case 'chevron': return `<path d="M-5 64L50 33L105 64V84L50 53L-5 84Z" fill="${c2}"/>`;
    case 'quarter': return `<path d="M50 0H100V50H50ZM0 50H50V100H0Z" fill="${c2}"/>`;
    default: return '';
  }
}

/** Left wing (mirrored for the right): three swept feathers behind the disc. */
const WING = 'M30 34L1 18Q6 30 16 34L3 36Q10 44 21 45L8 50Q16 57 27 56Z';

// ------------------------------------------------------------------ glyphs (100×100 box, centre 50,50)

/** Left laurel branch: leaves along an arc from bottom-left up to top-left (mirrored for the right). */
function wreathBranch() {
  let d = '';
  for (let i = 0; i < 7; i++) {
    const deg = 112 + i * 19; // 112° (bottom-left) -> 226° (top-left), y down
    const [x, y] = polar(50, 50, 35, deg);
    d += `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="7.4" ry="3.3" transform="rotate(${f1(deg + 90 - 32)} ${f1(x)} ${f1(y)})"/>`;
  }
  return d;
}

function glyphSVG(name, g, a, bg, parts) {
  switch (name) {
    case 'rocket':
      return `<path d="M50 6C60 18 63 32 63 50V70H37V50C37 32 40 18 50 6Z" fill="${g}"/>`
        + `<circle cx="50" cy="38" r="6.5" fill="${bg}"/><circle cx="50" cy="38" r="3.2" fill="${a}"/>`
        + `<path d="M37 52L24 68V80L37 72ZM63 52L76 68V80L63 72Z" fill="${g}"/>`
        + `<path d="M42 70H58L56 77H44Z" fill="${g}"/><path d="M44 79Q50 99 56 79Z" fill="${a}"/>`;
    case 'orbit':
      return `<g transform="rotate(-24 50 50)"><ellipse cx="50" cy="50" rx="44" ry="15" fill="none" stroke="${g}" stroke-width="4.5"/></g>`
        + `<circle cx="50" cy="50" r="17" fill="${g}" stroke="${bg}" stroke-width="4"/>`
        + `<g transform="rotate(-24 50 50)"><path d="M6 50A44 15 0 0 0 94 50" fill="none" stroke="${g}" stroke-width="4.5"/><circle cx="94" cy="50" r="5.5" fill="${a}"/></g>`;
    case 'star':
      return `<path d="${starPath(50, 52, 44, 18)}" fill="${g}"/><path d="${starPath(50, 52, 44, 18)}" fill="none" stroke="${a}" stroke-width="2" stroke-linejoin="round" opacity=".9" transform="translate(50 52) scale(.62) translate(-50 -52)"/>`;
    case 'planet':
      return `<g transform="rotate(-18 50 50)"><path d="M8 50A42 11 0 0 1 92 50" fill="none" stroke="${a}" stroke-width="4.5"/></g>`
        + `<circle cx="50" cy="50" r="24" fill="${g}"/><path d="M28 44Q50 38 72 44V50Q50 44 28 50Z" fill="${bg}" opacity=".28"/>`
        + `<g transform="rotate(-18 50 50)"><path d="M8 50A42 11 0 0 0 92 50" fill="none" stroke="${a}" stroke-width="4.5"/></g>`;
    case 'comet':
      return `<path d="M58 30L8 86L50 46Z" fill="${g}" opacity=".45"/><path d="M62 38L20 94L58 50Z" fill="${g}" opacity=".7"/>`
        + `<path d="M54 26L22 66L48 44Z" fill="${a}" opacity=".85"/><circle cx="64" cy="36" r="15" fill="${g}"/><circle cx="68" cy="32" r="5" fill="${bg}" opacity=".35"/>`;
    case 'capsule':
      return `<path d="M44 14H56V24H44Z" fill="${g}"/><path d="M42 24H58L70 72H30Z" fill="${g}"/>`
        + `<path d="M45 36H55V48H45Z" fill="${bg}"/><path d="M36 50H64" stroke="${bg}" stroke-width="2" opacity=".5"/>`
        + `<path d="M26 72H74Q74 84 50 84Q26 84 26 72Z" fill="${a}"/>`;
    case 'atom':
      return [0, 60, 120].map((r) => `<ellipse cx="50" cy="50" rx="43" ry="14" fill="none" stroke="${g}" stroke-width="4" transform="rotate(${r} 50 50)"/>`).join('')
        + `<circle cx="50" cy="50" r="9" fill="${a}"/><circle cx="93" cy="50" r="4.5" fill="${g}"/>`;
    case 'globe':
      return `<circle cx="50" cy="50" r="38" fill="none" stroke="${g}" stroke-width="5"/>`
        + `<ellipse cx="50" cy="50" rx="16" ry="38" fill="none" stroke="${g}" stroke-width="3.5"/>`
        + `<path d="M12 50H88M17 31Q50 39 83 31M17 69Q50 61 83 69M50 12V88" fill="none" stroke="${g}" stroke-width="3.2"/>`
        + `<circle cx="80" cy="22" r="5" fill="${a}"/>`;
    case 'wreath':
      return `<g fill="${g}">${wreathBranch()}<g transform="matrix(-1 0 0 1 100 0)">${wreathBranch()}</g></g>`
        + `<path d="M36 86Q50 80 64 86" fill="none" stroke="${g}" stroke-width="3.4" stroke-linecap="round"/><path d="${starPath(50, 50, 19, 8)}" fill="${a}"/>`;
    default: {
      const tpl = parts?.paths?.[name];
      if (typeof tpl === 'string') return tpl.replace(/\{g\}/g, g).replace(/\{a\}/g, a).replace(/\{b\}/g, bg);
      return `<path d="${starPath(50, 52, 44, 18)}" fill="${g}"/>`;
    }
  }
}

// ------------------------------------------------------------------ text

const esc = (s) => String(s).replace(/[<>&"']/g, '');
function fitSize(text, width, max, k = 0.66) {
  const n = Math.max(1, [...String(text)].length);
  return Math.max(4, Math.min(max, width / (n * k)));
}
function textEl(x, y, text, fs, fill, extra = '') {
  return `<text x="${f1(x)}" y="${f1(y)}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${f1(fs)}" fill="${fill}" letter-spacing="${f1(fs * 0.06)}"${extra}>${esc(text)}</text>`;
}

/** Banner across the lower part of the badge with the text on a gentle arch. */
function ribbon(uid, y, text, col) {
  const ink = inkFor(col);
  const dark = shade(col, -0.35);
  const fs = fitSize(text, 66, 11.5, 0.7);
  return `<path d="M13 ${y - 4}H2L7 ${y + 3}L2 ${y + 10}H17Z" fill="${dark}"/><path d="M87 ${y - 4}H98L93 ${y + 3}L98 ${y + 10}H83Z" fill="${dark}"/>`
    + `<path d="M10 ${y - 7}Q50 ${y - 12} 90 ${y - 7}V${y + 7}Q50 ${y + 2} 10 ${y + 7}Z" fill="${col}"/>`
    + `<path d="M10 ${y - 7}Q50 ${y - 12} 90 ${y - 7}V${y + 7}Q50 ${y + 2} 10 ${y + 7}Z" fill="none" stroke="${dark}" stroke-width="1"/>`
    + `<path id="${uid}r" d="M14 ${y + 3.6}Q50 ${y - 1.4} 86 ${y + 3.6}" fill="none"/>`
    + `<text font-family="${FONT}" font-weight="800" font-size="${f1(fs)}" fill="${ink}" letter-spacing="${f1(fs * 0.08)}" text-anchor="middle"><textPath href="#${uid}r" startOffset="50%">${esc(text)}</textPath></text>`;
}

/** Small stars spread along an arc (deg from +x, y down). */
function arcStars(n, cx, cy, r, from, to, size, fill) {
  if (n <= 0) return '';
  let d = '';
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const [x, y] = polar(cx, cy, r, from + (to - from) * t);
    d += starPath(x, y, size, size * 0.42);
  }
  return `<path d="${d}" fill="${fill}"/>`;
}

// ------------------------------------------------------------------ render

/**
 * emblemSVG(spec, {size, title, detail}) -> SVG string (viewBox 0 0 100 100). detail: 0 small, 1 mid, 2 full
 * (default from size). Cached by (spec, size, detail).
 */
export function emblemSVG(spec, { size = 48, title, detail, cls = 'emblem' } = {}) {
  const parts = REG.parts;
  const n = normalizeSpec(spec, { parts });
  const lod = Number.isInteger(detail) ? Math.max(0, Math.min(2, detail)) : size >= 72 ? 2 : size >= 44 ? 1 : 0;
  const key = `${JSON.stringify(n)}|${size}|${lod}|${title || ''}|${cls}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const svg = render(n, size, lod, title, cls, parts);
  if (CACHE.size >= CACHE_CAP) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, svg);
  return svg;
}

function render(n, size, lod, title, cls, parts) {
  const uid = `em${hash32(JSON.stringify(n), lod).toString(36)}`;
  const { shape, field, field2 } = n;
  const rim = shade(field, luminance(field) > 0.5 ? -0.3 : -0.42);
  const g = readable(n.glyphColor, field, 1.8);
  const acc = readable(n.accent, field, 1.5) === n.accent ? n.accent : g;
  const outline = OUTLINE[shape];
  const hasRing = !!n.ring && shape === 'roundel';
  const ringCol = n.ring?.color || rim;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" class="${esc(cls)}">`);
  if (title) out.push(`<title>${esc(title)}</title>`);
  out.push(`<defs><clipPath id="${uid}c"><path d="${outline}"/></clipPath></defs>`);

  // ---- wings behind the disc
  if (shape === 'wing') {
    const wc = field2 === field ? shade(field, 0.25) : field2;
    out.push(`<g fill="${wc}" stroke="${rim}" stroke-width="1.2" stroke-linejoin="round"><path d="${WING}"/><path d="${WING}" transform="matrix(-1 0 0 1 100 0)"/></g>`);
  }
  // ---- body: field, division, rim and inner keyline
  out.push(`<path d="${outline}" fill="${field}"/>`);
  const div = divisionLayer(n.division, field2);
  if (div) out.push(`<g clip-path="url(#${uid}c)">${div}</g>`);
  if (hasRing) {
    const ink = inkFor(ringCol);
    out.push(`<path d="M3 50a47 47 0 1 0 94 0a47 47 0 1 0-94 0ZM14 50a36 36 0 1 0 72 0a36 36 0 1 0-72 0Z" fill="${ringCol}" fill-rule="evenodd"/>`);
    out.push(`<circle cx="50" cy="50" r="36" fill="none" stroke="${ink}" stroke-width="1.2" opacity=".55"/>`);
    // ring content: text on top, stars (or the label) at the bottom
    const top = lod >= 2 ? (n.ring.text || n.label) : lod === 1 ? n.label : '';
    if (top) {
      const fs = fitSize(top, 98, lod >= 2 ? 8.6 : 10.5, 0.68);
      out.push(`<path id="${uid}t" d="M9.5 50A40.5 40.5 0 0 1 90.5 50" fill="none"/>`);
      out.push(`<text font-family="${FONT}" font-weight="800" font-size="${f1(fs)}" fill="${ink}" letter-spacing="${f1(fs * 0.12)}" text-anchor="middle"><textPath href="#${uid}t" startOffset="50%">${esc(top)}</textPath></text>`);
    }
    const ns = lod === 0 ? Math.min(n.stars, 3) : n.stars;
    if (ns > 0) out.push(arcStars(ns, 50, 50, 41.5, ns > 6 ? 150 : 128, ns > 6 ? 30 : 52, ns > 8 ? 2.6 : 3.2, ink));
    else if (lod >= 2 && n.ring.text && n.label) {
      const fs = fitSize(n.label, 52, 8.2, 0.68);
      out.push(`<path id="${uid}b" d="M5.6 50A44.4 44.4 0 0 0 94.4 50" fill="none"/>`);
      out.push(`<text font-family="${FONT}" font-weight="800" font-size="${f1(fs)}" fill="${ink}" letter-spacing="${f1(fs * 0.12)}" text-anchor="middle"><textPath href="#${uid}b" startOffset="50%">${esc(n.label)}</textPath></text>`);
    } else if (lod >= 1) {
      out.push(`<circle cx="8.6" cy="56" r="1.6" fill="${ink}"/><circle cx="91.4" cy="56" r="1.6" fill="${ink}"/>`);
    }
  }
  out.push(`<path d="${outline}" fill="none" stroke="${rim}" stroke-width="${lod === 0 ? 3.4 : 2.6}" stroke-linejoin="round"/>`);
  if (!hasRing && shape !== 'wordmark') {
    out.push(`<path d="${outline}" fill="none" stroke="${g}" stroke-width="${lod === 0 ? 1.8 : 1.3}" stroke-linejoin="round" opacity=".5" transform="translate(50 50) scale(.88) translate(-50 -50)"/>`);
  }

  // ---- charge position
  const ribbonY = { shield: 79, hex: 80, chevron: 72, wing: 82, star: 80, roundel: 80 }[shape];
  const showRibbon = lod >= 1 && shape !== 'wordmark' && !hasRing && n.label;
  let [cx, cy, sc] = shape === 'roundel'
    ? (hasRing ? CHARGE.roundel.ring : lod === 0 ? CHARGE.roundel.small : CHARGE.roundel.plain)
    : (lod === 0 ? CHARGE[shape].small : CHARGE[shape].full);
  if (shape === 'roundel' && !hasRing && lod >= 1) { cx = 50; cy = 42; sc = 0.5; }
  const glyphBg = field;
  const charge = (s) => `<g transform="translate(${f1(cx)} ${f1(cy)}) scale(${f1(s * 100) / 100}) translate(-50 -50)">${glyphSVG(n.glyph, g, acc, glyphBg, parts)}</g>`;

  // ---- orbit swooshes: back half, charge, front half
  const orbits = [];
  for (let i = 0; i < n.orbit; i++) {
    const rx = shape === 'wordmark' ? 44 : hasRing ? 31 : 40;
    const ry = shape === 'wordmark' ? 13 : 10.5;
    const oy = shape === 'wordmark' ? 52 : cy + 2;
    const rot = i === 0 ? -16 : 22;
    orbits.push({ rx, ry, oy, rot, w: lod === 0 ? 3.4 : 2.6 });
  }
  const swoosh = (o, half) => `<g transform="rotate(${o.rot} 50 ${f1(o.oy)})"><path d="M${f1(50 - o.rx)} ${f1(o.oy)}A${o.rx} ${o.ry} 0 0 ${half} ${f1(50 + o.rx)} ${f1(o.oy)}" fill="none" stroke="${acc}" stroke-width="${o.w}" stroke-linecap="round"${half ? '' : ' opacity=".55"'}/></g>`;
  const clipOpen = shape === 'roundel' || shape === 'hex' || shape === 'shield' ? `<g clip-path="url(#${uid}c)">` : '<g>';
  if (orbits.length) out.push(clipOpen + orbits.map((o) => swoosh(o, 0)).join('') + '</g>');

  if (shape === 'wordmark') {
    const lab = n.label || '?';
    const fs = fitSize(lab, 80, lab.length <= 3 ? 30 : 26, 0.7);
    const ink = readable(n.glyphColor, field, 3);
    if (lod >= 1 || lab.length <= 4) out.push(charge(lod >= 1 ? sc : 0.2));
    const ty = lod >= 1 ? 62 : 60;
    out.push(textEl(50, ty, lab, lod === 0 ? Math.min(32, fs * 1.08) : fs, ink));
    if (lod >= 2 && n.ring?.text) out.push(textEl(50, 75, n.ring.text, fitSize(n.ring.text, 76, 6.2, 0.7), ink, ' opacity=".8"'));
    if (lod >= 1 && n.stars) {
      const xs = [24, 76, 14, 86].slice(0, Math.min(4, n.stars));
      out.push(`<path d="${xs.map((x) => starPath(x, 32, 3, 1.3)).join('')}" fill="${acc}"/>`);
    }
  } else {
    // stars arc above the charge (shields and badges), or a circle of stars when there are many
    if (!hasRing && n.stars > 0 && lod >= 1) {
      if (n.stars >= 8) out.push(arcStars(n.stars, cx, cy, 27, -90, 270 - 360 / n.stars, 2.4, acc));
      else {
        const top = shape === 'chevron' ? 16 : shape === 'shield' ? 17 : 15;
        out.push(arcStars(n.stars, 50, cy + 30, cy + 30 - top, -90 - 9 * n.stars, -90 + 9 * n.stars, 2.9, acc));
      }
    }
    out.push(charge(!hasRing && n.stars >= 8 && lod >= 1 ? sc * 0.78 : sc));
  }
  if (orbits.length) out.push(clipOpen + orbits.map((o) => swoosh(o, 1)).join('') + '</g>');

  // ---- ribbon with the motto (full) or the label (mid)
  if (showRibbon) {
    const text = lod >= 2 && n.ring?.text ? n.ring.text : n.label;
    const col = n.ring?.color || (contrast(field2, field) > 1.4 ? field2 : shade(field, -0.38));
    out.push(ribbon(uid, ribbonY, text, col));
  }
  out.push('</svg>');
  return out.join('');
}

/** Convenience: SVG of an actor-like object (see specForActor). */
export function actorEmblemSVG(actor, opts = {}) {
  return emblemSVG(specForActor(actor), opts);
}

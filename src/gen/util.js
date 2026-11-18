// Shared helpers of the procedural generators (C8). Pure, deterministic, no DOM, no Math.random.
// Every generator takes either an `rng` (makeRng-compatible: next/int/pick/weighted) or a `seed` + labels.

import { rngFor, hash32 } from '../core/rng.js';

export { hash32 };

/** rng from options: an explicit rng wins (lifecycle passes its own), else rngFor(seed, 'gen', ...labels). */
export function rngOf(opts, ...labels) {
  if (opts?.rng) return opts.rng;
  return rngFor(opts?.seed ?? 0, 'gen', ...labels);
}

/** Fill {key} placeholders; unknown keys stay as-is (so callers can detect them). */
export const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

/** Lower-case, accent-free form used for comparisons. */
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** id-safe slug (^[a-z0-9_]+$). */
export const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** Pick by weight `w` (or `weight`), null on empty. */
export function weighted(rng, items) {
  return rng.weighted(items, (x) => x.w ?? x.weight ?? 1);
}

/** Uniform float in [a,b] from a [a,b] pair or a number. */
export const span = (rng, r, dflt = 0) => (Array.isArray(r) ? r[0] + (r[1] - r[0]) * rng.next() : Number.isFinite(r) ? r : dflt);

export const round = (x, step = 1) => {
  const d = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(x / step) * step).toFixed(d));
};

/** Era id of a year from a [[fromYear, eraId], …] table (ascending). */
export function eraOfYear(table, year, dflt = 'e5') {
  let out = dflt;
  for (const [from, id] of table || []) if (year >= from) out = id;
  return out;
}

const ERA_ORDER = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
export const eraIndex = (id) => ERA_ORDER.indexOf(id);

/** Union of per-era pools up to (and including) `eraId`, newest era first (so the current flavour dominates). */
export function poolUpTo(byEra, eraId, { only = false } = {}) {
  if (!byEra) return [];
  if (only) return (byEra[eraId] || []).slice();
  const out = [];
  for (let i = eraIndex(eraId); i >= 0; i--) out.push(...(byEra[ERA_ORDER[i]] || []));
  return out;
}

/** Nearest era (at or before eraId) that has an entry in `byEra`. */
export function nearestEra(byEra, eraId) {
  for (let i = eraIndex(eraId); i >= 0; i--) if (byEra?.[ERA_ORDER[i]]) return byEra[ERA_ORDER[i]];
  for (let i = eraIndex(eraId) + 1; i < ERA_ORDER.length; i++) if (byEra?.[ERA_ORDER[i]]) return byEra[ERA_ORDER[i]];
  return null;
}

/** Turn a {year, month} or bare year into {year, month}. */
export const ym = (d) => (typeof d === 'number' ? { year: d, month: 0 } : { year: d?.year ?? 0, month: d?.month ?? 0 });

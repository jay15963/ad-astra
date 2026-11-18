// Lossless compact encoding of long-campaign saves (1950–3000). Pure, no DOM, no data needed.
//
// A late save is mostly repeated key names: 600 nation pairs with the same seven fields, lists of news, ledger rows,
// history entries… serialize() writes, for campaigns longer than 10 years (state.endTurn > 520):
//   - state.world.pairs as {"$p": [[key, flip, level, pressure, sinceTurn, peak, changes], …]} (a/b come from the key;
//     a pair with any other shape is kept as [key, object]);
//   - every array of ≥ 3 plain objects that share the same keys in the same order as {"$c": [keys], "$r": [[values], …]}
//     (nested values are encoded the same way), except under state.actors (the title screen reads it raw);
//   - a top-level "$pack": 1 marker.
// unpackState() rebuilds exactly the same objects (same keys, same order, same values), so
// serialize(deserialize(json)) === json still holds and the sim never sees the encoding. Saves without the marker
// (the Corrida Lunar, older builds) are returned untouched.

export const PACK_MARK = '$pack';
const LONG_TURNS = 520;
const PAIR_KEYS = ['a', 'b', 'level', 'pressure', 'sinceTurn', 'peak', 'changes'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// keys JSON.stringify would write (undefined and functions are skipped)
const jsonKeys = (o) => Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function');
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** True when this state is written in the compact form. */
export const packable = (state) => Number.isFinite(state?.endTurn) && state.endTurn > LONG_TURNS;

function packValue(v) {
  if (Array.isArray(v)) return packArray(v);
  if (isPlain(v)) return packObject(v);
  return v;
}

function packObject(o) {
  let out = null;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === null || typeof v !== 'object') continue;
    const p = packValue(v);
    if (p !== v) {
      if (!out) out = { ...o };
      out[k] = p;
    }
  }
  return out || o;
}

function packArray(arr) {
  if (arr.length >= 3 && arr.every(isPlain)) {
    // key lists ("shapes") of the rows, in order of first appearance
    const shapes = [];
    const index = new Map();
    const ids = arr.map((o) => {
      const cols = jsonKeys(o);
      const sig = cols.join('\u0001');
      let i = index.get(sig);
      if (i === undefined) { i = shapes.length; index.set(sig, i); shapes.push(cols); }
      return i;
    });
    if (shapes.length === 1 && shapes[0].length) {
      const cols = shapes[0];
      return { $c: cols, $r: arr.map((o) => cols.map((c) => packValue(o[c]))) };
    }
    // a few shapes shared by many rows (missions, calendar instances, contracts): [shape, ...values] per row
    if (shapes.length > 1 && shapes.length * 2 <= arr.length) {
      return { $s: shapes, $r: arr.map((o, n) => [ids[n], ...shapes[ids[n]].map((c) => packValue(o[c]))]) };
    }
  }
  let out = null;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null || typeof v !== 'object') continue;
    const p = packValue(v);
    if (p !== v) {
      if (!out) out = arr.slice();
      out[i] = p;
    }
  }
  return out || arr;
}

function packPairs(pairs) {
  const list = [];
  for (const k of Object.keys(pairs)) {
    const p = pairs[k];
    if (p === undefined) continue;
    const keys = isPlain(p) ? jsonKeys(p) : null;
    const canonical = keys && keys.length === PAIR_KEYS.length && keys.every((x, i) => x === PAIR_KEYS[i])
      && typeof p.a === 'string' && typeof p.b === 'string' && !p.a.includes('|') && !p.b.includes('|') && p.a !== p.b
      && pairKey(p.a, p.b) === k && PAIR_KEYS.slice(2).every((f) => p[f] === null || typeof p[f] !== 'object');
    if (canonical) list.push([k, p.a < p.b ? 0 : 1, p.level, p.pressure, p.sinceTurn, p.peak, p.changes]);
    else list.push([k, packValue(p)]);
  }
  return { $p: list };
}

// research.rivals {actor: [tech ids]}: the same few hundred ids repeated by every rival → one string table + indexes
function packIdLists(obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length || !keys.every((k) => Array.isArray(obj[k]) && obj[k].every((x) => typeof x === 'string'))) return null;
  const table = [];
  const at = new Map();
  const idx = {};
  for (const k of keys) {
    idx[k] = obj[k].map((id) => {
      let i = at.get(id);
      if (i === undefined) { i = table.length; at.set(id, i); table.push(id); }
      return i;
    });
  }
  return { $t: table, $i: idx };
}
const isIdLists = (v) => isPlain(v) && Array.isArray(v.$t) && isPlain(v.$i) && Object.keys(v).length === 2;
function unpackIdLists(v) {
  const out = {};
  for (const k of Object.keys(v.$i)) out[k] = v.$i[k].map((i) => v.$t[i]);
  return out;
}

/** The object serialize() writes (the live state is never mutated). */
export function packState(state) {
  if (!packable(state)) return state;
  const out = { ...state };
  for (const k of Object.keys(state)) {
    if (k === 'actors') continue;
    const v = state[k];
    if (v === null || typeof v !== 'object') continue;
    if (k === 'world' && isPlain(v) && isPlain(v.pairs)) {
      const w = packObject({ ...v, pairs: null });
      out.world = { ...w, pairs: packPairs(v.pairs) };
      continue;
    }
    if (k === 'research' && isPlain(v) && isPlain(v.rivals)) {
      const lists = packIdLists(v.rivals);
      if (lists) {
        const r = packObject({ ...v, rivals: null });
        out.research = { ...r, rivals: lists };
        continue;
      }
    }
    out[k] = packValue(v);
  }
  out[PACK_MARK] = 1;
  return out;
}

const isPackedArray = (v) => isPlain(v) && Array.isArray(v.$c) && Array.isArray(v.$r) && Object.keys(v).length === 2;

const isShapedArray = (v) => isPlain(v) && Array.isArray(v.$s) && Array.isArray(v.$r) && Object.keys(v).length === 2;

function unpackValue(v) {
  if (isPackedArray(v)) {
    const cols = v.$c;
    return v.$r.map((row) => {
      const o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = unpackValue(row[i]);
      return o;
    });
  }
  if (isShapedArray(v)) {
    return v.$r.map((row) => {
      const cols = v.$s[row[0]];
      const o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = unpackValue(row[i + 1]);
      return o;
    });
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = unpackValue(v[i]);
    return v;
  }
  if (isPlain(v)) {
    for (const k of Object.keys(v)) v[k] = unpackValue(v[k]);
    return v;
  }
  return v;
}

function unpackPairs(packed) {
  const pairs = {};
  for (const e of packed.$p) {
    if (e.length === 2) { pairs[e[0]] = unpackValue(e[1]); continue; }
    const [k, flip, level, pressure, sinceTurn, peak, changes] = e;
    const i = k.indexOf('|');
    const lo = k.slice(0, i), hi = k.slice(i + 1);
    pairs[k] = { a: flip ? hi : lo, b: flip ? lo : hi, level, pressure, sinceTurn, peak, changes };
  }
  return pairs;
}

/** Undo packState on a parsed save (in place). Saves without the marker come back unchanged. */
export function unpackState(s) {
  if (!isPlain(s) || s[PACK_MARK] !== 1) return s;
  delete s[PACK_MARK];
  for (const k of Object.keys(s)) {
    if (k === 'actors') continue;
    if (k === 'world' && isPlain(s.world) && isPlain(s.world.pairs) && Array.isArray(s.world.pairs.$p)) {
      const pairs = unpackPairs(s.world.pairs);
      s.world.pairs = null;
      unpackValue(s.world);
      s.world.pairs = pairs;
      continue;
    }
    if (k === 'research' && isPlain(s.research) && isIdLists(s.research.rivals)) {
      const rivals = unpackIdLists(s.research.rivals);
      s.research.rivals = null;
      unpackValue(s.research);
      s.research.rivals = rivals;
      continue;
    }
    s[k] = unpackValue(s[k]);
  }
  return s;
}

// Lossless compact encoding of long-campaign saves (1950–3000). Pure, no DOM, no data needed.
//
// A late save is mostly repeated key names: 600 nation pairs with the same seven fields, lists of news, ledger rows,
// history entries… serialize() writes, for campaigns longer than 10 years (state.endTurn > 520):
//   - state.world.pairs as {"$p": [[key, flip, level, pressure, sinceTurn, peak, changes], …]} (a/b come from the key;
//     a pair with any other shape is kept as [key, object]);
//   - every array of ≥ 3 plain objects that share the same keys in the same order as {"$c": [keys], "$r": [[values], …]}
//     (nested values are encoded the same way), except under state.actors (the title screen reads it raw);
//   - every object of ≥ 3 plain objects (vehicleStats, tombstones…) the same way, with its keys: {"$k": [keys], …};
//   - research: rivals' tech id lists share one string table; unlocked, completedTurn and the bonus maps index it;
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

// a map of ≥ 3 plain objects sharing a few shapes (vehicleStats, tombstones, annals…): keys once, rows of values
const MAP_MIN = 3;
function packMap(o) {
  const keys = jsonKeys(o);
  if (keys.length < MAP_MIN || keys.some((k) => k.startsWith('$')) || !keys.every((k) => isPlain(o[k]))) return null;
  const arr = keys.map((k) => o[k]);
  const p = packArray(arr);
  if (p === arr || !(isPackedArray(p) || isShapedArray(p))) return null;
  return { $k: keys, ...p };
}
const isPackedMap = (v) => isPlain(v) && Array.isArray(v.$k) && Array.isArray(v.$r) && (Array.isArray(v.$c) || Array.isArray(v.$s)) && Object.keys(v).length === 3;

function packObject(o) {
  const m = packMap(o);
  if (m) return m;
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
// indexes into a table of ≤ 1296 ids as fixed 2-character base-36 codes, joined in one string ("0a0b1z…")
const CODE_MAX = 36 * 36;
const toCodes = (list) => list.map((i) => i.toString(36).padStart(2, '0')).join('');
function fromCodes(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 2) out.push(parseInt(str.slice(i, i + 2), 36));
  return out;
}
const isIdLists = (v) => isPlain(v) && Array.isArray(v.$t) && (isPlain(v.$i) || isPlain(v.$j)) && Object.keys(v).length === 2;
function unpackIdLists(v) {
  const out = {};
  if (isPlain(v.$j)) for (const k of Object.keys(v.$j)) out[k] = fromCodes(v.$j[k]).map((i) => v.$t[i]);
  else for (const k of Object.keys(v.$i)) out[k] = v.$i[k].map((i) => v.$t[i]);
  return out;
}
/** Once the table is final: numeric index lists → code strings (when every index fits in 2 characters). */
function codeResearch(lists, extra) {
  if (lists.$t.length > CODE_MAX) return lists;
  if (extra.unlocked) extra.unlocked = { $u: toCodes(extra.unlocked.$u) };
  if (extra.completedTurn) {
    const v = extra.completedTurn.$v;
    // turns as fixed 4-character base-36 codes when they are all whole weeks in 0..36⁴ − 1
    const turns = v.every((t) => Number.isInteger(t) && t >= 0 && t < 36 ** 4) ? v.map((t) => t.toString(36).padStart(4, '0')).join('') : v;
    extra.completedTurn = { $k: toCodes(extra.completedTurn.$k), $v: turns };
  }
  return { $t: lists.$t, $j: Object.fromEntries(Object.keys(lists.$i).map((k) => [k, toCodes(lists.$i[k])])) };
}
const idxList = (v) => (typeof v === 'string' ? fromCodes(v) : v);

// research.unlocked / research.completedTurn / research.bonus: the same tech ids (and effect names) again → indexes
// into the rivals' string table (ids missing from it are appended) and one table of effect names. Lossless: order of
// lists and of object keys is kept.
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNumMap = (v) => isPlain(v) && Object.keys(v).every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
function packResearchExtra(r, lists) {
  const table = lists.$t;
  const at = new Map(table.map((id, i) => [id, i]));
  const ix = (id) => { let i = at.get(id); if (i === undefined) { i = table.length; at.set(id, i); table.push(id); } return i; };
  const out = {};
  if (isStrList(r.unlocked)) out.unlocked = { $u: r.unlocked.map(ix) };
  if (isNumMap(r.completedTurn)) { const ks = Object.keys(r.completedTurn); out.completedTurn = { $k: ks.map(ix), $v: ks.map((k) => r.completedTurn[k]) }; }
  if (isPlain(r.bonus) && Object.keys(r.bonus).every((a) => isNumMap(r.bonus[a]))) {
    const names = [];
    const nat = new Map();
    const b = {};
    for (const a of Object.keys(r.bonus)) {
      const row = [];
      for (const k of Object.keys(r.bonus[a])) {
        let i = nat.get(k);
        if (i === undefined) { i = names.length; nat.set(k, i); names.push(k); }
        row.push(i, r.bonus[a][k]);
      }
      b[a] = row;
    }
    out.bonus = { $e: names, $b: b };
  }
  return out;
}
function unpackResearchExtra(r, table) {
  if (isPlain(r.unlocked) && r.unlocked.$u != null) r.unlocked = idxList(r.unlocked.$u).map((i) => table[i]);
  if (isPlain(r.completedTurn) && r.completedTurn.$k != null) {
    const o = {};
    const v = r.completedTurn.$v;
    const turnAt = typeof v === 'string' ? (n) => parseInt(v.slice(n * 4, n * 4 + 4), 36) : (n) => v[n];
    idxList(r.completedTurn.$k).forEach((i, n) => { o[table[i]] = turnAt(n); });
    r.completedTurn = o;
  }
  if (isPlain(r.bonus) && Array.isArray(r.bonus.$e) && isPlain(r.bonus.$b)) {
    const names = r.bonus.$e;
    const o = {};
    for (const a of Object.keys(r.bonus.$b)) {
      const row = r.bonus.$b[a];
      const e = {};
      for (let i = 0; i < row.length; i += 2) e[names[row[i]]] = row[i + 1];
      o[a] = e;
    }
    r.bonus = o;
  }
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
        const extra = packResearchExtra(v, lists);
        const coded = codeResearch(lists, extra);
        const r = packObject({ ...v, rivals: null, ...Object.fromEntries(Object.keys(extra).map((k) => [k, null])) });
        out.research = { ...r, rivals: coded, ...extra };
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
  if (isPackedMap(v)) {
    const { $k: keys, ...rows } = v;
    const list = unpackValue(rows);
    const o = {};
    keys.forEach((k, i) => { o[k] = list[i]; });
    return o;
  }
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
      const r = s.research;
      const table = r.rivals.$t;
      const rivals = unpackIdLists(r.rivals);
      const keep = {};
      for (const f of ['unlocked', 'completedTurn', 'bonus']) if (isPlain(r[f]) && (r[f].$u != null || r[f].$k != null || r[f].$e)) { keep[f] = r[f]; r[f] = null; }
      r.rivals = null;
      unpackValue(r);
      r.rivals = rivals;
      Object.assign(r, keep);
      unpackResearchExtra(r, table);
      continue;
    }
    s[k] = unpackValue(s[k]);
  }
  return s;
}

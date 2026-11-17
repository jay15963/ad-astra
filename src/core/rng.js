// Deterministic, stateless-friendly RNG. Pure JS, no DOM. Works in browser and Node.
// Never use Math.random() in src/sim or src/core: always derive an rng from the state seed.

/** 32-bit string/number hash (FNV-1a variant + avalanche). */
export function hash32(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x9e; h = Math.imul(h, 16777619) >>> 0; // separator
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Create a seeded RNG object (mulberry32). */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x6d2b79f5;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    /** float in [0,1) */
    next,
    /** float in [min,max) */
    range: (min, max) => min + (max - min) * next(),
    /** integer in [min,max] inclusive */
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    /** true with probability p */
    chance: (p) => next() < p,
    /** random element */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** weighted pick: items [{weight, ...}] or (items, weightFn) */
    weighted: (items, weightFn = (x) => x.weight) => {
      let total = 0;
      for (const it of items) total += Math.max(0, weightFn(it));
      if (total <= 0) return null;
      let r = next() * total;
      for (const it of items) {
        r -= Math.max(0, weightFn(it));
        if (r < 0) return it;
      }
      return items[items.length - 1];
    },
    /** approx normal(mean, sd) via sum of uniforms */
    normal: (mean = 0, sd = 1) => {
      let s = 0;
      for (let i = 0; i < 6; i++) s += next();
      return mean + sd * (s - 3) / Math.SQRT1_2; // var(sum of 6 U) = 0.5
    },
    /** in-place-free shuffle copy */
    shuffle: (arr) => {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
  return rng;
}

/**
 * Stateless derivation: the same (seed, ...labels) always yields the same stream.
 * Use rngFor(state.seed, 'politics', state.turn) inside ticks so save/load never changes outcomes.
 */
export function rngFor(seed, ...labels) {
  return makeRng(hash32(seed, ...labels));
}

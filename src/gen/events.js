// Procedural narrative events for the speculative eras (C8). Data: data/gen/gen-events.json.
// Each template becomes up to `variants` events, one per slot set picked by the seed. Slot markers are filled here;
// only the narrative engine's own markers ({actor}, {rival}, {person}, …) remain. Output rows pass
// src/sim/narrative.js validateEvent (tested), carry ids `gen_ev_<era>_<template>_<k>`, truthLayer 'especulacao' and
// a trigger window inside the era.
//
//   genEvents(E, {eraId, seed|rng, maxPerTemplate?}) -> event[]
//   genAllEvents(E, {seed}) -> event[] for every era in the file

import { rngOf } from './util.js';

const fillSlots = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

function fillDeep(x, vars) {
  if (typeof x === 'string') return fillSlots(x, vars);
  if (Array.isArray(x)) return x.map((y) => fillDeep(y, vars));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillDeep(v, vars)]));
  return x;
}

export function genEvents(E, opts = {}) {
  const eraId = opts.eraId || 'e5';
  const win = E.eras?.[eraId] || {};
  const rng = rngOf(opts, 'events', eraId);
  const out = [];
  for (const t of E.templates?.[eraId] || []) {
    const n = Math.min(t.variants ?? 1, opts.maxPerTemplate ?? Infinity, (t.slots || [{}]).length);
    const slots = rng.shuffle(t.slots?.length ? t.slots : [{}]).slice(0, n);
    slots.forEach((vars, i) => {
      const ev = {
        id: `gen_ev_${eraId}_${t.id}_${i + 1}`, kind: 'narrative',
        title: fillSlots(t.title, vars), text: fillSlots(t.text, vars),
        ...(t.portrait ? { portrait: t.portrait } : {}),
        trigger: { fromYear: t.from ?? win.from, untilYear: t.until ?? win.until },
        weight: t.weight ?? 4, cooldownWeeks: t.cooldownWeeks ?? 104,
        ...(t.once ? { once: true } : {}),
        group: t.group, tags: (t.tags || []).slice(),
        choices: fillDeep(t.choices || [], vars),
        era: eraId, truthLayer: 'especulacao',
      };
      out.push(ev);
    });
  }
  return out;
}

export function genAllEvents(E, opts = {}) {
  return Object.keys(E.templates || {}).flatMap((eraId) => genEvents(E, { ...opts, eraId }));
}

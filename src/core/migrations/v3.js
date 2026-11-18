// Save migration v2 → v3 (docs/EXPANSION.md §11, Phase B): the investors slices (B2) — `cap` (the player's cap
// table, null until the investors module builds it on the next tick) and `mandates`. Phase A missions in
// `planning` keep their hardware (no retro-nulling). `designs` (B3) is left to its module's ensureSlices, which
// must tolerate the slice being absent (mandatory pattern).
// Registered on import (src/sim/investors.js imports this file); pure, idempotent.
import { registerMigration } from '../migrate.js';

export function v2to3(s) {
  if (!('cap' in s)) s.cap = null;
  if (!Array.isArray(s.mandates)) s.mandates = [];
  s.version = 3;
  return s;
}

registerMigration(2, v2to3);

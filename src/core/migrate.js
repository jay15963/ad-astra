// Save migration (EXPANSION.md §11). Pure, no DOM. migrate(raw, data) → state, or throws SaveError {code, message}.
// v1 (v0.5, all Corrida Lunar) → v2 (clock, eras, lifecycle, annals). Later phases add entries to MIGRATIONS
// (Phase B: v2 → v3 in src/core/migrations/v3.js, registered with registerMigration).

import { unpackState } from './savepack.js';

export const SAVE_VERSION = 2;

/** Player-facing rejection texts (pt-BR, binding wording). */
export const SAVE_ERROR_MESSAGES = {
  newer: 'Este save é de uma versão mais nova do Ad Astra. Atualize o jogo para continuar.',
  unreadable: 'Não foi possível ler este save. Ele pode estar corrompido ou ser de uma versão antiga demais.',
  scenario: 'Este save usa um cenário que não existe nesta versão.',
};

export class SaveError extends Error {
  /** @param {'newer'|'unreadable'|'scenario'} code */
  constructor(code, detail = null, version = null) {
    super(SAVE_ERROR_MESSAGES[code] || SAVE_ERROR_MESSAGES.unreadable);
    this.name = 'SaveError';
    this.code = SAVE_ERROR_MESSAGES[code] ? code : 'unreadable';
    this.detail = detail; // developer detail (not shown to players)
    this.version = version;
  }
}

/** Scenario ids every build knows, plus whatever the loaded data advertises. */
export function knownScenarios(data) {
  const ids = new Set(['lunar_race', 'campaign']);
  if (data?.scenario?.id) ids.add(data.scenario.id);
  for (const s of data?.scenarioIndex?.scenarios || []) if (s?.id) ids.add(s.id);
  return ids;
}

/** Index of the band containing a year in the default table (used by the v1 → v2 step: b5 = 2026–2050). */
const B5_IDX = 4;

/** fromVersion → fn(state, data) returning the state at fromVersion + 1. */
export const MIGRATIONS = {
  1: function v1to2(s) {
    s.scenarioId ??= 'lunar_race';
    s.clock = {
      eraId: 'e4', stepWeeks: 1, bandIdx: B5_IDX, steps: s.turn, eraStartTurn: 0, pendingEra: null, paceMult: 1,
      turnWeeks: 1, finalTurn: null, endingPushed: false,
    };
    s.eraHistory = [];
    s.lifecycle = { applied: {}, tombstones: {}, aliases: {} };
    s.annals = {};
    s.dataPacks = {};
    s.version = 2;
    return s;
  },
};

/** Phase B+: add a migration step without editing this file's table by hand. */
export function registerMigration(fromVersion, fn) {
  MIGRATIONS[fromVersion] = fn;
}

/** Highest version this build can produce (SAVE_VERSION, or higher once later migrations are registered). */
export function targetVersion() {
  let v = SAVE_VERSION;
  while (MIGRATIONS[v]) v++;
  return v;
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function checkShape(s) {
  const missing = [];
  if (!Number.isFinite(s.turn)) missing.push('turn');
  if (!Number.isFinite(s.seed)) missing.push('seed');
  if (!Number.isFinite(s.startYear)) missing.push('startYear');
  if (typeof s.playerId !== 'string') missing.push('playerId');
  if (!isObj(s.actors)) missing.push('actors');
  if (!Array.isArray(s.decisions)) missing.push('decisions');
  if (!Array.isArray(s.news)) missing.push('news');
  return missing;
}

/**
 * @param {string|object} raw  serialized save (JSON text) or an already parsed object (not mutated when a string)
 * @param {object} [data]       loaded game data (for the scenario check); optional
 * @returns {object} state at targetVersion()
 */
export function migrate(raw, data) {
  let s;
  if (typeof raw === 'string') {
    try { s = JSON.parse(raw); } catch (e) { throw new SaveError('unreadable', `JSON: ${e.message}`); }
  } else s = raw;
  if (!isObj(s)) throw new SaveError('unreadable', 'não é um objeto');
  // compact encoding of long-campaign saves (src/core/savepack.js): back to the plain state first
  try { unpackState(s); } catch (e) { throw new SaveError('unreadable', `pacote: ${e.message}`); }
  const v = Number(s.version);
  if (!Number.isInteger(v) || v < 1) throw new SaveError('unreadable', `versão ${s.version}`);
  const target = targetVersion();
  if (v > target) throw new SaveError('newer', `versão ${v} > ${target}`, v);
  const missing = checkShape(s);
  if (missing.length) throw new SaveError('unreadable', `faltam campos: ${missing.join(', ')}`, v);
  try {
    for (let cur = v; cur < target; cur++) {
      const step = MIGRATIONS[cur];
      if (!step) throw new Error(`sem migração a partir da v${cur}`);
      s = step(s, data) || s;
      s.version = cur + 1;
    }
  } catch (e) {
    throw new SaveError('unreadable', `migração: ${e.message}`, v);
  }
  if (data && !knownScenarios(data).has(s.scenarioId ?? 'lunar_race')) throw new SaveError('scenario', s.scenarioId, v);
  return s;
}

// Time model (EXPANSION.md §1). The internal unit is the week: 52 per year (simplified calendar).
// turn 0 = first week of state.startYear (1950 in the campaign, 2026 in the Corrida Lunar). Every scheduled field
// (launchTurn, arriveTurn, expiresTurn…) is an absolute week. One player "turn" (one tap on the disc) advances
// `stepWeeks` weeks, which depends on the period (bands of data/core/eras.json); the Corrida Lunar uses 1.

export const WEEKS_PER_YEAR = 52;

export const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** turn -> {year, week (1..52), month (0..11), monthName} */
export function turnToDate(turn, startYear) {
  const year = startYear + Math.floor(turn / WEEKS_PER_YEAR);
  const week = (((turn % WEEKS_PER_YEAR) + WEEKS_PER_YEAR) % WEEKS_PER_YEAR) + 1; // negative turns = before the campaign
  const month = Math.min(11, Math.floor((week - 1) / (WEEKS_PER_YEAR / 12)));
  return { year, week, month, monthName: MONTHS_PT[month] };
}

/** (year, month 0..11) -> first turn of that month */
export function dateToTurn(year, month, startYear) {
  // ceil matches turnToDate (floor), so the returned turn really falls in that month
  return (year - startYear) * WEEKS_PER_YEAR + Math.ceil(month * (WEEKS_PER_YEAR / 12));
}

/** "abr/2026" */
export function formatTurn(turn, startYear) {
  const d = turnToDate(turn, startYear);
  return `${d.monthName}/${d.year}`;
}

/** "sem 14 · abr/2026" */
export function formatTurnLong(turn, startYear) {
  const d = turnToDate(turn, startYear);
  return `sem ${d.week} · ${d.monthName}/${d.year}`;
}

/** Duration in pt-BR: "3 sem", "5 meses", "2,5 anos", "3 décadas", "2 séculos". */
export function weeksToText(w) {
  if (w < 9) return `${w} sem`;
  if (w < 104) return `${Math.round(w / (WEEKS_PER_YEAR / 12))} meses`;
  const years = w / WEEKS_PER_YEAR;
  if (years < 20) return `${years.toFixed(1).replace('.', ',')} anos`;
  if (years < 100) return `${Math.round(years)} anos`;
  if (years < 200) return `${(years / 100).toFixed(1).replace('.', ',')} século`;
  return `${Math.round(years / 100)} séculos`;
}

// ---------------------------------------------------------------------------------------------------------------
// Eras and step bands
// ---------------------------------------------------------------------------------------------------------------

/**
 * Fallback copy of data/core/eras.json, used only when the core pack is not in `data` (old loader, tests that build
 * data by hand). tests/time-bands.test.mjs checks that it equals the JSON file, so the data stays the source of truth.
 */
export const DEFAULT_ERAS = {
  final: { year: 3000, month: 0 },
  eras: [
    { id: 'e1', n: 1, name: 'A Corrida', from: { year: 1950, month: 0 }, to: { year: 1975, month: 11 }, truthLayer: 'fato', milestone: 'Pouso na Lua e Apollo-Soyuz' },
    { id: 'e2', n: 2, name: 'Estações e Sondas', from: { year: 1976, month: 0 }, to: { year: 1999, month: 11 }, truthLayer: 'fato', milestone: 'Primeiros módulos da ISS' },
    { id: 'e3', n: 3, name: 'A Era Comercial', from: { year: 2000, month: 0 }, to: { year: 2025, month: 11 }, truthLayer: 'fato', milestone: 'Reuso de foguetes vira rotina' },
    { id: 'e4', n: 4, name: 'A Década Lunar', from: { year: 2026, month: 0 }, to: { year: 2050, month: 11 }, truthLayer: 'plano_oficial', milestone: 'Base lunar permanente' },
    { id: 'e5', n: 5, name: 'Expansão do Sistema', from: { year: 2051, month: 0 }, to: { year: 2199, month: 11 }, truthLayer: 'especulacao', milestone: 'Primeira colônia autônoma' },
    { id: 'e6', n: 6, name: 'Interplanetária e Interestelar', from: { year: 2200, month: 0 }, to: { year: 2599, month: 11 }, truthLayer: 'especulacao', milestone: 'Primeiro pouso em outro sol' },
    { id: 'e7', n: 7, name: 'Galáctica', from: { year: 2600, month: 0 }, to: { year: 2999, month: 11 }, truthLayer: 'especulacao', milestone: 'O Grande Silêncio' },
  ],
  bands: [
    { id: 'b1', from: 1950, to: 1955, eraId: 'e1', stepWeeks: 13 },
    { id: 'b2', from: 1956, to: 1975, eraId: 'e1', stepWeeks: 2 },
    { id: 'b3', from: 1976, to: 1999, eraId: 'e2', stepWeeks: 4 },
    { id: 'b4', from: 2000, to: 2025, eraId: 'e3', stepWeeks: 4 },
    { id: 'b5', from: 2026, to: 2050, eraId: 'e4', stepWeeks: 2 },
    { id: 'b6', from: 2051, to: 2199, eraId: 'e5', stepWeeks: 13 },
    { id: 'b7', from: 2200, to: 2599, eraId: 'e6', stepWeeks: 26 },
    { id: 'b8', from: 2600, to: 2989, eraId: 'e7', stepWeeks: 52 },
    { id: 'b9', from: 2990, to: 2999, eraId: 'e7', stepWeeks: 13 },
  ],
};

/**
 * The era table from data, tolerant of shapes: data.eras may be the eras.json object ({eras, bands, final}),
 * a plain array of eras (then bands come from data.erasBands or the fallback), or absent.
 */
export function eraTable(data) {
  const src = data?.eras;
  if (src && !Array.isArray(src) && Array.isArray(src.eras) && Array.isArray(src.bands)) {
    return { eras: src.eras, bands: src.bands, final: src.final || DEFAULT_ERAS.final };
  }
  if (Array.isArray(src) && src.length && src[0]?.from) {
    return { eras: src, bands: data.erasBands || DEFAULT_ERAS.bands, final: data.erasFinal || DEFAULT_ERAS.final };
  }
  return DEFAULT_ERAS;
}

const yearFrom = (x) => (typeof x === 'number' ? x : x?.year);

/** Calendar year of a turn: startYear + floor(turn / 52). */
export function yearOf(state, turn = state?.turn ?? 0) {
  return (state?.startYear ?? 0) + Math.floor(turn / WEEKS_PER_YEAR);
}

/** Era definition for a calendar year (years before e1 → e1, after e7 → e7). */
export function eraAt(data, year) {
  const { eras } = eraTable(data);
  let hit = eras[0];
  for (const e of eras) if (yearFrom(e.from) <= year) hit = e;
  return hit;
}

/** Era definition by id (or null). */
export function eraById(data, id) {
  return eraTable(data).eras.find((e) => e.id === id) || null;
}

/** First turn of the era that follows the one containing `turn` (Infinity after the last era). */
export function nextEraTurn(data, state, turn = state.turn) {
  const { eras } = eraTable(data);
  const y = yearOf(state, turn);
  for (const e of eras) {
    const f = e.from;
    const t = dateToTurn(yearFrom(f), f?.month ?? 0, state.startYear);
    if (yearFrom(f) > y && t > turn) return t;
  }
  return Infinity;
}

/**
 * Step band for a turn: {stepWeeks, eraId, idx}. A fixed `turnWeeks` (scenario, kept in state.clock.turnWeeks)
 * overrides the band's step; the era always comes from the calendar.
 */
export function bandAt(data, state, turn = state.turn) {
  const { bands } = eraTable(data);
  const y = yearOf(state, turn);
  let idx = 0;
  for (let i = 0; i < bands.length; i++) if (bands[i].from <= y) idx = i;
  const b = bands[idx];
  const fixed = state?.clock?.turnWeeks;
  const stepWeeks = Number.isFinite(fixed) && fixed > 0 ? fixed : b.stepWeeks;
  return { stepWeeks, eraId: eraAt(data, y)?.id ?? b.eraId, idx };
}

/** Next grid point after `turn` (≥ turn + 1): the next multiple of the band's step. */
export function gridNext(data, state, turn = state.turn) {
  const { stepWeeks } = bandAt(data, state, turn);
  return (Math.floor(turn / stepWeeks) + 1) * stepWeeks;
}

/** Disc label for a step length. */
export function stepLabel(weeks) {
  switch (weeks) {
    case 1: return '+1 sem';
    case 2: return '+2 sem';
    case 4: return '+4 sem';
    case 13: return '+1 trimestre';
    case 26: return '+1 semestre';
    case 52: return '+1 ano';
    default: return `+${weeksToText(weeks)}`;
  }
}

/**
 * Date chip at the precision the era plays at: weekly/monthly steps "mar/1962", quarters "T3 2087",
 * semesters "S1 2300", years "2741".
 */
export function formatTurnEra(turn, startYear, stepWeeks = 1) {
  const d = turnToDate(turn, startYear);
  if (stepWeeks >= 52) return `${d.year}`;
  if (stepWeeks >= 26) return `S${Math.floor((d.week - 1) / 26) + 1} ${d.year}`;
  if (stepWeeks >= 13) return `T${Math.floor((d.week - 1) / 13) + 1} ${d.year}`;
  return `${d.monthName}/${d.year}`;
}

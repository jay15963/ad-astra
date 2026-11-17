// Time model. One turn = one week in the Lunar Race scenario (2026-2030).
// turn 0 = first week of START_YEAR. 52 weeks per year (simplified calendar).

export const WEEKS_PER_YEAR = 52;

export const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** turn -> {year, week (1..52), month (0..11), monthName} */
export function turnToDate(turn, startYear) {
  const year = startYear + Math.floor(turn / WEEKS_PER_YEAR);
  const week = (turn % WEEKS_PER_YEAR) + 1;
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

export function weeksToText(w) {
  if (w < 9) return `${w} sem`;
  if (w < 104) return `${Math.round(w / (WEEKS_PER_YEAR / 12))} meses`;
  return `${(w / WEEKS_PER_YEAR).toFixed(1).replace('.', ',')} anos`;
}

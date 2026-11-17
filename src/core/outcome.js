// Outcome vocabulary + quick background resolution (AI/rival launches). No imports by contract.
// Levels: total > partial > recoverable > catastrophic. Five failure types (GDD "Confiabilidade e risco").

export const OUTCOMES = ['total', 'partial', 'recoverable', 'catastrophic'];

// ---------- prestige (one scale for the player and the AI: same feat, same points) ----------

/** Difficulty → base prestige (destination.prestige in data wins). */
export const DEST_PRESTIGE = {
  leo: 3, sso: 3, gto: 3, iss: 4, cislunar: 8, lunar_orbit: 10, lunar_surface: 18, lunar_south_pole: 24,
  mars_orbit: 22, mars_surface: 32, jupiter: 30, titan: 38,
};
const PRESTIGE_BY_KEY = { leo: 3, gto: 3, tli: 12, mars: 24, outer: 32 };

export function destPrestige(dest) {
  if (!dest) return 3;
  return dest.prestige ?? DEST_PRESTIGE[dest.id] ?? PRESTIGE_BY_KEY[dest.capacityKey] ?? 5;
}

/**
 * Prestige of a resolved mission. opts: { crewed, level, p (estimated chance), repeats (earlier successes of this actor
 * at the same destination), strategyMult, contract }. Returns { base, prestige, firstPoints }.
 * firstPoints = what a first at this destination is worth (helpers.claimFirst scales historic feats down).
 */
export function missionPrestige(dest, { crewed = false, level = 'total', p = 0.8, repeats = 0, strategyMult = 1, contract = false } = {}) {
  const base = destPrestige(dest) * (crewed ? 1.8 : 1);
  // long odds pay more (smooth, no cliff)
  const bold = Math.min(0.3, Math.max(0, (0.75 - p) * 0.8)) + (crewed ? 0.1 : 0);
  // repetition is less newsworthy; contract deliveries are a service
  const novelty = Math.max(0.15, 1 / (1 + 0.55 * Math.max(0, repeats))) * (contract ? 0.5 : 1);
  const ok = level === 'total' || level === 'partial';
  const prestige = ok ? Math.round(base * (level === 'total' ? 1 : 0.45) * (1 + bold) * novelty * strategyMult) : 0;
  return { base, prestige, firstPoints: 30 + Math.round(base), novelty, bold };
}
export const FAILURE_TYPES = ['propulsion', 'structure', 'software', 'human', 'environment'];

export const OUTCOME_LABELS = {
  total: 'Sucesso total',
  partial: 'Sucesso parcial',
  recoverable: 'Falha recuperável',
  catastrophic: 'Falha catastrófica',
};

export const FAILURE_LABELS = {
  propulsion: 'Propulsão',
  structure: 'Estrutura',
  software: 'Software',
  human: 'Fator humano',
  environment: 'Ambiente',
};

/** Short pt-BR explanation of each failure type (relatório de causas). */
export const FAILURE_DESCRIPTIONS = {
  propulsion: 'motor, turbobomba ou linhas de combustível',
  structure: 'tanques, juntas, escudo ou carga aerodinâmica',
  software: 'guiagem, sensores ou lógica de voo',
  human: 'procedimento, comunicação ou decisão da equipe',
  environment: 'clima, vento, radiação ou terreno',
};

/** Generic split of failure types when nothing better is known. */
export const DEFAULT_FAILURE_WEIGHTS = { propulsion: 0.36, structure: 0.22, software: 0.2, human: 0.1, environment: 0.12 };

/** Split of non-total results for background launches (sums to 1). */
export const DEFAULT_FAILURE_SPLIT = { partial: 0.34, recoverable: 0.3, catastrophic: 0.36 };

/** Score used for sorting/prestige: 1 total .. 0 catastrophic. */
export const OUTCOME_SCORE = { total: 1, partial: 0.6, recoverable: 0.2, catastrophic: 0 };

export const isSuccess = (level) => level === 'total' || level === 'partial';

// rng may be an rng object ({next}) or a bare () => float function.
const nextOf = (rng) => (typeof rng === 'function' ? rng : () => rng.next());

/** Weighted pick of a failure type from {type: weight}. */
export function pickFailureType(rng, weights = DEFAULT_FAILURE_WEIGHTS) {
  const next = nextOf(rng);
  let total = 0;
  for (const t of FAILURE_TYPES) total += Math.max(0, weights?.[t] || 0);
  if (total <= 0) return 'propulsion';
  let r = next() * total;
  for (const t of FAILURE_TYPES) {
    r -= Math.max(0, weights?.[t] || 0);
    if (r < 0) return t;
  }
  return FAILURE_TYPES[FAILURE_TYPES.length - 1];
}

/**
 * Quick outcome for background/AI launches.
 * Total success with probability ~p; the remainder splits between partial/recoverable/catastrophic.
 * opts: { failureWeights?, split?: {partial, recoverable, catastrophic}, crewed? (crewed flights skew to recoverable: abort systems) }
 * Always consumes exactly three rng draws so callers stay in sync.
 */
export function quickOutcome(rng, p, opts = {}) {
  const next = nextOf(rng);
  const pp = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0.9));
  const r1 = next();
  const r2 = next();
  const r3 = next();
  if (r1 < pp) return { level: 'total', failureType: null };
  let split = { ...DEFAULT_FAILURE_SPLIT, ...(opts.split || {}) };
  if (opts.crewed) split = { partial: split.partial, recoverable: split.recoverable + split.catastrophic * 0.5, catastrophic: split.catastrophic * 0.5 };
  const tot = split.partial + split.recoverable + split.catastrophic || 1;
  let level;
  if (r2 * tot < split.partial) level = 'partial';
  else if (r2 * tot < split.partial + split.recoverable) level = 'recoverable';
  else level = 'catastrophic';
  return { level, failureType: pickFailureType(() => r3, opts.failureWeights || DEFAULT_FAILURE_WEIGHTS) };
}

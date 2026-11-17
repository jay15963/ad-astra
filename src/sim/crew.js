// Crew (module "crew", slices state.crew and state.memorial).
// People with faces, traits, loyalty and history: hiring market (weekly, deterministic), training, salaries,
// morale/loyalty drift, rival poaching, retirement, injuries, deaths (Memorial), legends and legacies
// (relatives of fallen/legendary people show up in the hiring market).
// Only the player's agency has individual people in state.crew; rivals are abstract.

import { addNews, emitSignal, clamp, changeActor, pushDecision } from '../core/helpers.js';
import { rngFor } from '../core/rng.js';
import { techBonus, addSciencePoints } from './research.js';
import * as budget from './budget.js';

const ROLES = ['engineer', 'flight_director', 'astronaut'];
const IN_SPACE = ['launch', 'transit', 'arrival', 'operations'];
const FINISHED = ['done', 'cancelled'];
const HISTORY_CAP = 40;
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- data helpers ----------
const crewData = (data) => data?.crew || {};
const ccfg = (data) => crewData(data).config || {};
const traitMap = new WeakMap();
function traitsOf(data) {
  const key = crewData(data);
  if (!traitMap.has(key)) traitMap.set(key, Object.fromEntries((key.traits || []).map((t) => [t.id, t])));
  return traitMap.get(key);
}
/** Sum of a trait effect key across a person's traits. */
function trait(data, p, key) {
  const T = traitsOf(data);
  let s = 0;
  for (const id of p?.traits || []) s += T[id]?.effects?.[key] || 0;
  return s;
}
/** Multiplicative trait effect (e.g. leaveChance 1.5 × 0.2). */
function traitMult(data, p, key) {
  const T = traitsOf(data);
  let m = 1;
  for (const id of p?.traits || []) { const v = T[id]?.effects?.[key]; if (typeof v === 'number') m *= v; }
  return m;
}
const g = (p, f, m) => (p?.gender === 'f' ? f : m); // gendered pt-BR word
function roleLabel(data, p) {
  const R = crewData(data).roles?.[p.role] || {};
  return g(p, R.labelF, R.labelM) || R.label || p.role;
}
function actorName(state, id) {
  const a = state.actors?.[id];
  return a ? a.short || a.name || id : id || 'uma rival';
}

function ensure(state) {
  if (!state.crew || typeof state.crew !== 'object' || Array.isArray(state.crew)) state.crew = {};
  if (!Array.isArray(state.memorial)) state.memorial = [];
  return state.crew;
}
const playerPeople = (state) => Object.values(state.crew || {}).filter((p) => p && p.actorId === state.playerId);
const alive = (p) => p && p.status !== 'dead';
const onPayroll = (p) => p && (p.status === 'active' || p.status === 'injured');

export function addHistory(state, p, text) {
  if (!p) return;
  p.history = p.history || [];
  p.history.push({ turn: state.turn, text });
  if (p.history.length > HISTORY_CAP) p.history.splice(0, p.history.length - HISTORY_CAP);
}

// ---------- mission links (read-only on state.missions) ----------
function missionsWith(state, id, statuses) {
  return (state.missions || []).filter((m) => {
    if (statuses && !statuses.includes(m.status)) return false;
    const c = m.crew || {};
    return c.flightDirector === id || c.commander === id || (c.astronauts || []).includes(id);
  });
}
function inSpace(state, id) {
  return (state.missions || []).some((m) => IN_SPACE.includes(m.status) &&
    (m.crew?.commander === id || (m.crew?.astronauts || []).includes(id)));
}
function assigned(state, id) {
  return (state.missions || []).some((m) => !FINISHED.includes(m.status) &&
    (m.crew?.flightDirector === id || m.crew?.commander === id || (m.crew?.astronauts || []).includes(id)));
}

// ---------- money ----------
function pay(state, amount, note, force = false) {
  if (!(amount > 0)) return true;
  const id = state.playerId;
  if (typeof budget.spend === 'function') {
    if (!force && typeof budget.canAfford === 'function' && !budget.canAfford(state, id, amount)) return false;
    return budget.spend(state, id, amount, 'crew', note) !== false || force;
  }
  const a = state.actors?.[id];
  if (!a) return true;
  if (!force && (a.cash ?? 0) < amount) return false;
  changeActor(state, id, 'cash', -amount);
  return true;
}
function canPay(state, amount) {
  if (typeof budget.canAfford === 'function') return !!budget.canAfford(state, state.playerId, amount);
  const a = state.actors?.[state.playerId];
  return !a || (a.cash ?? 0) >= amount;
}
const salaryFor = (data, role, skill, star = false) => {
  const base = crewData(data).roles?.[role]?.salaryM ?? 0.07;
  return Math.round(base * (0.6 + skill / 100) * (star ? 1.5 : 1) * 1000) / 1000;
};

// ---------- generation ----------
function cultureOf(data, actorId) {
  return crewData(data).actorCulture?.[actorId] || 'american';
}
function portraitFor(state, data, id, culture, role, partial = {}) {
  const P = crewData(data).portraitParts || {};
  const rng = rngFor(state.seed, 'portrait', id);
  const n = (k, d) => P[k] || d;
  const range = (map, d) => map?.[culture] || d;
  const [s0, s1] = range(P.cultureSkin, [0, n('skin', 6) - 1]);
  const [h0, h1] = range(P.cultureHairColor, [0, n('hairColor', 6) - 1]);
  return {
    skin: rng.int(s0, s1), hair: rng.int(0, n('hair', 10) - 1), hairColor: rng.int(h0, h1),
    eyes: rng.int(0, n('eyes', 5) - 1), brows: rng.int(0, n('brows', 4) - 1), mouth: rng.int(0, n('mouth', 5) - 1),
    accessory: rng.chance(0.6) ? 0 : rng.int(1, n('accessory', 6) - 1),
    suit: P.roleSuit?.[role] ?? rng.int(0, n('suit', 4) - 1), bg: rng.int(0, n('bg', 6) - 1),
    ...partial,
  };
}

function genderize(text, gender) {
  // "Conhecida(o)" → Conhecida/Conhecido ; "mergulhador(a)" → mergulhadora/mergulhador ; "dela(e)" → dela/dele
  return String(text)
    .replace(/(\p{L}+)a\(o\)/gu, (_, s) => (gender === 'f' ? `${s}a` : `${s}o`))
    .replace(/(\p{L}+)\(a\)/gu, (_, s) => (gender === 'f' ? `${s}a` : s))
    .replace(/(\p{L}+)a\(e\)/gu, (_, s) => (gender === 'f' ? `${s}a` : `${s}e`));
}

function pickTraits(data, rng, n, prefer = []) {
  const all = crewData(data).traits || [];
  const out = [];
  for (const id of prefer) if (traitsOf(data)[id] && out.length < n) out.push(id);
  let guard = 0;
  while (out.length < n && guard++ < 20) {
    const t = rng.weighted(all.filter((x) => !out.includes(x.id)), (x) => x.weight ?? 1);
    if (!t) break;
    // avoid contradictory pairs
    if ((t.id === 'leal' && out.includes('ambicioso')) || (t.id === 'ambicioso' && out.includes('leal'))) continue;
    if ((t.id === 'resistente' && out.includes('saude_fragil')) || (t.id === 'saude_fragil' && out.includes('resistente'))) continue;
    out.push(t.id);
  }
  return out;
}

/** Procedural person (hiring market, fallback rosters). */
function genPerson(state, data, rng, { id, actorId, culture, role, star = false, legacy = null }) {
  const C = crewData(data);
  culture = culture || cultureOf(data, actorId);
  role = role || rng.weighted(ROLES.map((r) => ({ r, weight: C.roles?.[r]?.share ?? 1 })))?.r || 'engineer';
  const gender = legacy?.gender || (rng.chance(0.5) ? 'f' : 'm');
  const female = new Set(C.femaleNames?.[culture] || []);
  const pool = (C.firstNames?.[culture] || ['Alex']).filter((nm) => (gender === 'f') === female.has(nm));
  const first = rng.pick(pool.length ? pool : C.firstNames?.[culture] || ['Alex']);
  const last = legacy?.surname || rng.pick(C.lastNames?.[culture] || ['Silva']);
  const name = (C.surnameFirst || []).includes(culture) ? `${last} ${first}` : `${first} ${last}`;
  const skill = star ? rng.int(80, 93) : clamp(Math.round(rng.normal(52, 11)), 25, 85);
  const age = role === 'astronaut' ? rng.int(29, 46) : role === 'flight_director' ? rng.int(33, 56) : rng.int(25, 55);
  const traits = pickTraits(data, rng, rng.chance(0.55) ? 2 : 1, star && rng.chance(0.6) ? ['ambicioso'] : []);
  const T = C.bioTemplates || {};
  let bio = genderize(rng.pick(T[role] || ['Integra a equipe técnica.'])
    .replace('{field}', rng.pick(T.fields || ['engenharia']))
    .replace('{quirk}', rng.pick(T.quirks || ['trabalho duro'])), gender);
  if (legacy) bio = `${legacy.relation} de ${legacy.name}. ${bio}`;
  const ambition = clamp(rng.int(30, 70) + traits.reduce((s, t) => s + (traitsOf(data)[t]?.effects?.ambition || 0), 0), 5, 95);
  return {
    id, name, gender, role, actorId, culture, age,
    skill, experience: Math.max(0, Math.round((age - 25) * rng.range(0.4, 1.3))),
    missions: 0, successes: 0, failures: 0, missionIds: [],
    traits, loyalty: rng.int(45, 70), ambition, morale: rng.int(58, 72),
    status: 'active', bio, history: [], legend: false, legendTurn: null,
    salaryM: salaryFor(data, role, skill, star), hiredTurn: state.turn,
    portrait: portraitFor(state, data, id, culture, role),
    injuredUntil: null, trainingUntil: null, lastFlightTurn: null, legacyOf: legacy?.crewId || null, star,
  };
}

/** Starting roster entry (data/crew.json roster) → full Person. */
function rosterPerson(state, data, e, actorId) {
  const culture = e.culture || cultureOf(data, actorId);
  const role = ROLES.includes(e.role) ? e.role : 'engineer';
  const skill = clamp(e.skill ?? 55, 0, 100);
  return {
    id: e.id, name: e.name, gender: e.gender || 'm', role, actorId, culture, age: e.age ?? 40,
    skill, experience: e.experience ?? 0, missions: e.missions ?? 0, successes: e.successes ?? 0, failures: e.failures ?? 0, missionIds: [],
    traits: (e.traits || []).filter((t) => traitsOf(data)[t]),
    loyalty: e.loyalty ?? 60, ambition: e.ambition ?? 50, morale: e.morale ?? 60,
    status: 'active', bio: e.bio || '', history: [], legend: !!e.legend, legendTurn: e.legend ? 0 : null,
    salaryM: e.salaryM ?? salaryFor(data, role, skill), hiredTurn: 0,
    portrait: portraitFor(state, data, e.id, culture, role, e.portrait || {}),
    injuredUntil: null, trainingUntil: null, lastFlightTurn: null, legacyOf: null, star: false,
  };
}

// ---------- init ----------

export function init(state, data, ctx) {
  ensure(state);
  const pid = state.playerId;
  const roster = crewData(data).roster?.[pid];
  const people = [];
  if (Array.isArray(roster) && roster.length) {
    for (const e of roster) if (e?.id && e?.name) people.push(rosterPerson(state, data, e, pid));
  } else {
    // fallback: procedural founding team (3 engineers, 2 flight directors, 3 astronauts)
    const rng = ctx?.rng ? ctx.rng('roster') : rngFor(state.seed, 'crew-roster', pid);
    const roles = ['engineer', 'engineer', 'engineer', 'flight_director', 'flight_director', 'astronaut', 'astronaut', 'astronaut'];
    roles.forEach((role, i) => people.push(genPerson(state, data, rng, { id: `${pid}_crew_${i + 1}`, actorId: pid, role })));
    for (const p of people) p.hiredTurn = 0;
  }
  for (const p of people) {
    addHistory(state, p, 'Integra a agência no início da Corrida Lunar.');
    state.crew[p.id] = p;
  }
}

// ---------- hiring market ----------

function legacyPool(state, beforeTurn) {
  const out = [];
  for (const m of state.memorial || []) if (m.turn < beforeTurn && state.crew[m.crewId]) out.push(state.crew[m.crewId]);
  for (const p of playerPeople(state)) {
    if (out.includes(p)) continue;
    if (p.legend && p.legendTurn != null && p.legendTurn < beforeTurn) out.push(p);
    else if (p.status === 'retired' && p.retiredTurn != null && p.retiredTurn < beforeTurn) out.push(p);
  }
  return out;
}

function surnameOf(data, p) {
  const parts = String(p.name).split(' ');
  return (crewData(data).surnameFirst || []).includes(p.culture) ? parts[0] : parts.slice(1).join(' ') || parts[0];
}

function candidateFor(state, data, week, i) {
  const M = ccfg(data).market || {};
  const id = `cand_${week}_${i}`;
  const rng = rngFor(state.seed, 'market', state.playerId, week, i);
  const home = cultureOf(data, state.playerId);
  const cultures = crewData(data).cultures || [home];
  const culture = rng.chance(M.foreignShare ?? 0.2) ? rng.pick(cultures) : home;
  const star = rng.chance(M.starChance ?? 0.06);
  let legacy = null;
  const pool = legacyPool(state, week);
  if (pool.length && rng.chance(M.legacyChance ?? 0.15)) {
    const src = rng.pick(pool);
    const gender = rng.chance(0.5) ? 'f' : 'm';
    legacy = {
      crewId: src.id, name: src.name, gender, surname: surnameOf(data, src),
      relation: rng.pick(crewData(data).relations?.[gender] || [gender === 'f' ? 'Filha' : 'Filho']),
    };
  }
  const p = genPerson(state, data, rng, { id, actorId: state.playerId, culture: legacy ? state.crew[legacy.crewId]?.culture || culture : culture, star, legacy });
  p.marketWeek = week;
  p.expiresTurn = week + (M.visibleWeeks ?? 4);
  p.signingM = Math.round(p.salaryM * (M.signingWeeks ?? 10) * (star ? 1.5 : 1) * 100) / 100;
  return p;
}

/** Candidates currently on the market: `perWeek` new each week, each visible for `visibleWeeks`. */
export function currentCandidates(state, data) {
  const M = ccfg(data).market || {};
  const per = M.perWeek ?? 2;
  const vis = M.visibleWeeks ?? 4;
  const out = [];
  for (let w = state.turn - vis + 1; w <= state.turn; w++) {
    for (let i = 0; i < per; i++) {
      const id = `cand_${w}_${i}`;
      if (state.crew?.[id]) continue; // already hired
      out.push(candidateFor(state, data, w, i));
    }
  }
  return out.reverse(); // newest first
}

// ---------- availability ----------

/** Player's people ready for a mission (active, not training, not in space). role optional. */
export function availableCrew(state, role) {
  return playerPeople(state).filter((p) =>
    p.status === 'active' && !(p.trainingUntil > state.turn) && (!role || p.role === role) && !inSpace(state, p.id));
}

function usable(state, id) {
  const p = state.crew?.[id];
  return p && p.status === 'active' && !(p.trainingUntil > state.turn) ? p : null;
}

// ---------- mission modifiers ----------

/**
 * crewModifier(state, data, crewSel, context?) → {delta, band, factors}
 * delta: additive success probability; band: fraction by which the chance band narrows (negative = wider).
 * context.destination (optional) enables landing-specific traits.
 */
export function crewModifier(state, data, crewSel = {}, context = {}) {
  const factors = [];
  let delta = 0;
  let band = 0;
  const add = (label, d, b = 0) => {
    d = Math.round(d * 1000) / 1000;
    delta += d; band += b;
    if (Math.abs(d) >= 0.001 || Math.abs(b) >= 0.01) factors.push({ label, delta: d });
  };
  const landing = /surface|south_pole|mars_surface/.test(context?.destination || '');
  const sel = crewSel || {};

  // flight director
  const fd = sel.flightDirector ? state.crew?.[sel.flightDirector] : null;
  if (!sel.flightDirector) add('Sem diretor(a) de voo designado', -0.03, -0.1);
  else if (!usable(state, sel.flightDirector)) add(`${fd?.name || 'Diretor(a) de voo'} indisponível`, -0.03, -0.1);
  else {
    const exp = Math.min(0.02, (fd.missions || 0) * 0.004);
    add(`${roleLabel(data, fd)}: ${fd.name} (${Math.round(fd.skill)})`, ((fd.skill - 50) / 50) * 0.04 + exp, ((fd.skill - 50) / 50) * 0.15);
    traitFactors(data, fd, add, 1, landing);
  }
  // commander
  const cmd = sel.commander ? state.crew?.[sel.commander] : null;
  if (sel.commander) {
    if (!usable(state, sel.commander)) add(`${cmd?.name || 'Comandante'} indisponível`, -0.04, -0.05);
    else {
      add(`Comandante: ${cmd.name} (${Math.round(cmd.skill)})`, ((cmd.skill - 50) / 50) * 0.03 + Math.min(0.015, (cmd.missions || 0) * 0.005), ((cmd.skill - 50) / 50) * 0.05);
      traitFactors(data, cmd, add, 1, landing);
    }
  }
  // other astronauts
  const astros = (sel.astronauts || []).filter((id) => id && id !== sel.commander);
  const okAstros = astros.map((id) => usable(state, id)).filter(Boolean);
  if (astros.length > okAstros.length) add('Tripulante(s) indisponível(is)', -0.02 * (astros.length - okAstros.length));
  if (okAstros.length) {
    const avg = okAstros.reduce((s, p) => s + p.skill, 0) / okAstros.length;
    add('Tripulação', ((avg - 50) / 50) * 0.015);
    for (const p of okAstros) traitFactors(data, p, add, 0.5, landing);
  }
  // engineering team (top 3 active engineers)
  const engs = playerPeople(state).filter((p) => p.role === 'engineer' && p.status === 'active').sort((a, b) => b.skill - a.skill).slice(0, 3);
  if (engs.length) {
    const avg = engs.reduce((s, p) => s + p.skill, 0) / engs.length;
    add('Equipe de engenharia', ((avg - 50) / 50) * 0.03, ((avg - 50) / 50) * 0.05);
  } else add('Sem engenheiros ativos', -0.03, -0.05);
  // morale of the people in the room
  const room = [fd, cmd, ...okAstros].filter((p) => p && usable(state, p.id));
  if (room.length) {
    const m = room.reduce((s, p) => s + (p.morale ?? 60), 0) / room.length;
    if (m < 35) add('Moral baixa na equipe', -0.02);
    else if (m > 80) add('Equipe confiante', 0.01);
  }
  return { delta: clamp(Math.round(delta * 1000) / 1000, -0.15, 0.12), band: clamp(Math.round(band * 100) / 100, -0.25, 0.4), factors };
}

function traitFactors(data, p, add, w, landing) {
  const T = traitsOf(data);
  for (const id of p.traits || []) {
    const e = T[id]?.effects || {};
    const d = ((e.missionDelta || 0) + (landing ? e.landingDelta || 0 : 0)) * w;
    const b = (e.band || 0) * w;
    if (d || b) add(`${p.name.split(' ')[0]}: ${T[id].name}`, d, b);
  }
}

/** Command points for a launch: 1..5 (flight director skill/experience/traits + commander traits + tech). */
export function commandPointsFor(state, data, crewSel = {}) {
  let pts = 1;
  const fd = usable(state, crewSel?.flightDirector);
  if (fd) {
    if (fd.skill >= 55) pts += 1;
    if (fd.skill >= 80) pts += 1;
    if ((fd.missions || 0) >= 3) pts += 1;
    pts += trait(data, fd, 'commandPoints') + trait(data, fd, 'commandPointsFD');
  }
  const cmd = usable(state, crewSel?.commander);
  if (cmd) pts += trait(data, cmd, 'commandPoints') * 0.5 + trait(data, cmd, 'commandPointsCmd');
  pts += techBonus(state, state.playerId, 'commandPoints');
  return clamp(Math.floor(pts), 1, 5);
}

// ---------- mission results ----------

const OK_LEVELS = ['total', 'partial'];

/**
 * applyMissionToCrew(state, data, mission, outcome) — outcome: level string or {level, failureType, crewLost?}.
 * If outcome.crewLost is an array it is authoritative (launch decided); otherwise deaths are rolled here
 * using techBonus('crewSafety') and survival traits. Returns {died, injured, legends}.
 */
export function applyMissionToCrew(state, data, mission, outcome) {
  ensure(state);
  const res = { died: [], injured: [], legends: [] };
  if (!mission) return res;
  const level = typeof outcome === 'string' ? outcome : outcome?.level || 'partial';
  const failureType = typeof outcome === 'object' ? outcome?.failureType : null;
  const C = ccfg(data);
  const XP = C.xp || {};
  const MOR = C.morale || {};
  const sel = mission.crew || {};
  const fd = state.crew[sel.flightDirector];
  const aboardIds = [...new Set([sel.commander, ...(sel.astronauts || [])].filter(Boolean))];
  const aboard = aboardIds.map((id) => state.crew[id]).filter((p) => p && alive(p));
  const team = [fd, ...aboard].filter((p) => p && alive(p) && p.actorId === state.playerId);
  const hasMentor = team.some((p) => trait(data, p, 'mentorXp') > 0);
  const name = mission.name || 'missão';
  const success = OK_LEVELS.includes(level);

  // experience, morale, history for the team
  for (const p of team) {
    const first = !(p.missionIds || []).includes(mission.id);
    if (first) {
      p.missionIds = [...(p.missionIds || []), mission.id].slice(-50);
      p.missions = (p.missions || 0) + 1;
      if (success) p.successes = (p.successes || 0) + 1; else p.failures = (p.failures || 0) + 1;
    }
    let xp = (XP.base ?? 10) + (XP[level] ?? 0);
    xp *= 1 + trait(data, p, 'xpGain');
    if (hasMentor && (p.missions || 0) <= 2 && trait(data, p, 'mentorXp') === 0) xp *= 1.4;
    gainXp(p, xp);
    moraleChange(data, p, MOR[level] ?? 0);
    if (aboard.includes(p)) p.lastFlightTurn = state.turn;
    addHistory(state, p, missionLine(p, data, name, level, aboard.includes(p)));
  }

  // deaths and injuries aboard
  const crewed = aboard.length > 0;
  if (crewed && level === 'catastrophic') {
    let lost;
    if (Array.isArray(outcome?.crewLost)) lost = aboard.filter((p) => outcome.crewLost.includes(p.id));
    else {
      const safety = techBonus(state, state.playerId, 'crewSafety');
      lost = aboard.filter((p) => {
        const pd = clamp((C.deathChance ?? 0.85) - safety - trait(data, p, 'survival'), 0.1, 0.95);
        return rngFor(state.seed, 'crew-death', mission.id, state.turn, p.id).chance(pd);
      });
    }
    for (const p of lost) { killPerson(state, data, p, mission, failureType); res.died.push(p.id); }
    for (const p of aboard) {
      if (p.status === 'dead') continue;
      if (rngFor(state.seed, 'crew-injury', mission.id, state.turn, p.id).chance((C.injury?.catastrophic ?? 0.5) + trait(data, p, 'injuryChance'))) {
        injure(state, data, p, `Ferida(o) na ${name}`); res.injured.push(p.id);
      }
    }
  } else if (crewed && level === 'recoverable') {
    for (const p of aboard) {
      if (rngFor(state.seed, 'crew-injury', mission.id, state.turn, p.id).chance((C.injury?.recoverable ?? 0.15) + trait(data, p, 'injuryChance'))) {
        injure(state, data, p, `Ferida(o) no aborto da ${name}`); res.injured.push(p.id);
      }
    }
  }

  // rest of the agency: engineers learn, everyone feels the result
  const others = playerPeople(state).filter((p) => onPayroll(p) && !team.includes(p));
  for (const p of others) {
    if (p.role === 'engineer') gainXp(p, XP.engineer ?? 2);
    moraleChange(data, p, (MOR[level] ?? 0) * 0.4 + res.died.length * (MOR.death ?? -20) * 0.5);
  }
  for (const p of team) if (p.status !== 'dead' && res.died.length) moraleChange(data, p, (MOR.death ?? -20) * 0.6);

  // legends
  for (const p of team) {
    if (p.status === 'dead' || p.legend) continue;
    if (isLegendary(state, data, p, mission, level, aboard.includes(p))) { makeLegend(state, data, p, mission); res.legends.push(p.id); }
  }

  // public charisma and field science on success
  if (level === 'total') {
    const sup = team.reduce((s, p) => s + (p.status !== 'dead' ? trait(data, p, 'supportOnSuccess') : 0), 0);
    if (sup) changeActor(state, state.playerId, 'support', sup);
  }
  if (success) {
    const sci = aboard.reduce((s, p) => s + (p.status !== 'dead' ? trait(data, p, 'scienceBonus') : 0), 0);
    if (sci) addSciencePoints(state, sci * (level === 'total' ? 1 : 0.5), 'crew');
  }
  if (state.stats) state.stats['crew.missionsApplied'] = (state.stats['crew.missionsApplied'] || 0) + 1;
  return res;
}

function gainXp(p, xp) {
  p.experience = r1((p.experience || 0) + xp);
  p.skill = r1(Math.min(99, p.skill + xp * 0.25 * Math.max(0, 1 - p.skill / 105)));
}
function moraleChange(data, p, d) {
  const swing = traitMult(data, p, 'moraleSwing');
  p.morale = r1(clamp((p.morale ?? 60) + d * swing, 0, 100));
}

function missionLine(p, data, name, level, aboard) {
  const verb = aboard ? 'Voou na' : p.role === 'flight_director' ? 'Dirigiu a' : 'Trabalhou na';
  const res = { total: 'sucesso total', partial: 'sucesso parcial', recoverable: 'falha recuperável', catastrophic: 'catástrofe' }[level] || level;
  return `${verb} ${name}: ${res}.`;
}

function isLegendary(state, data, p, mission, level, isAboard) {
  const L = ccfg(data).legend || {};
  if ((p.missions || 0) >= (L.missions ?? 4) && (p.successes || 0) >= (L.successes ?? 3)) return true;
  if (p.role === 'flight_director' && (p.successes || 0) >= (L.fdSuccesses ?? 4)) return true;
  if (isAboard && level === 'total' && (L.destinations || []).includes(mission.destination)) return true;
  if (isAboard && level === 'catastrophic') return true; // survived the worst
  if (mission.result?.firstClaimed && level === 'total') return true;
  return false;
}

function makeLegend(state, data, p, mission) {
  p.legend = true;
  p.legendTurn = state.turn;
  p.morale = clamp((p.morale ?? 60) + 10, 0, 100);
  p.loyalty = clamp((p.loyalty ?? 60) + 10, 0, 100);
  p.ambition = clamp((p.ambition ?? 50) + 5, 0, 100);
  addHistory(state, p, `Virou lenda da agência depois da ${mission?.name || 'missão'}.`);
  addNews(state, {
    headline: `${p.name} entra para a história da agência`,
    body: `${roleLabel(data, p)} com ${p.missions} missões. ${g(p, 'Ela', 'Ele')} agora é ${g(p, 'uma lenda', 'uma lenda')}.`,
    tags: ['crew', 'legend'], actors: [state.playerId], importance: 3, icon: '⭐',
  });
  emitSignal(state, 'crew/legend', { crewId: p.id, actorId: state.playerId });
}

function killPerson(state, data, p, mission, failureType) {
  p.status = 'dead';
  p.deathTurn = state.turn;
  p.trainingUntil = null;
  p.injuredUntil = null;
  const cause = ccfg(data).failureCause?.[failureType] || 'Acidente em missão';
  addHistory(state, p, `Morreu a serviço na ${mission?.name || 'missão'}. ${cause}.`);
  state.memorial.push({ crewId: p.id, name: p.name, role: p.role, turn: state.turn, missionId: mission?.id ?? null, cause, legend: !!p.legend });
  addNews(state, {
    headline: `Luto: ${p.name} morre na ${mission?.name || 'missão'}`,
    body: `${roleLabel(data, p)}, ${p.age} anos, ${p.missions} missões. O nome vai para o Memorial.`,
    tags: ['crew', 'death', 'memorial'], actors: [state.playerId], importance: 3, icon: '🕯️',
  });
  if (state.stats) state.stats['crew.deaths'] = (state.stats['crew.deaths'] || 0) + 1;
  emitSignal(state, 'crew/died', { crewId: p.id, missionId: mission?.id ?? null, actorId: state.playerId });
}

function injure(state, data, p, text) {
  const I = ccfg(data).injury || {};
  const [a, b] = I.weeks || [4, 16];
  const rng = rngFor(state.seed, 'injury-weeks', p.id, state.turn);
  const weeks = Math.max(1, Math.round(rng.int(a, b) * (1 - techBonus(state, state.playerId, 'injuryReduction'))));
  p.status = 'injured';
  p.injuredUntil = state.turn + weeks;
  p.trainingUntil = null;
  addHistory(state, p, `${genderize(text, p.gender)} (${weeks} semanas fora).`);
}

function leave(state, data, p, toActor, reason) {
  p.status = 'left';
  p.leftTurn = state.turn;
  p.leftTo = toActor || null;
  addHistory(state, p, reason);
  emitSignal(state, 'crew/left', { crewId: p.id, to: toActor || null, actorId: state.playerId });
}

// ---------- status helpers for other modules (narrative effects) ----------

/** Change a numeric field of a person with clamping (skill, morale, loyalty, ambition 0..100; experience >= 0). */
export function changeCrew(state, crewId, field, delta) {
  const p = state.crew?.[crewId];
  if (!p || typeof delta !== 'number') return;
  const lim = { skill: [0, 100], morale: [0, 100], loyalty: [0, 100], ambition: [0, 100], experience: [0, Infinity] }[field];
  if (!lim) return;
  p[field] = r1(clamp((p[field] || 0) + delta, lim[0], lim[1]));
}

/** Narrative {crewStatus}: 'left' | 'injured' | 'retired' | 'active'. */
export function setCrewStatus(state, data, crewId, status, reason = '') {
  const p = state.crew?.[crewId];
  if (!p || p.status === 'dead') return false;
  if (status === 'injured') injure(state, data, p, reason || 'Ferida(o) fora de missão');
  else if (status === 'left') leave(state, data, p, null, reason || 'Deixou a agência.');
  else if (status === 'retired') { p.status = 'retired'; p.retiredTurn = state.turn; addHistory(state, p, reason || 'Aposentou-se.'); }
  else if (status === 'active') { p.status = 'active'; p.injuredUntil = null; }
  else return false;
  return true;
}

/** Deterministic random pick among the player's active people (filter optional). */
export function pickCrew(state, rng, filter = () => true) {
  const list = playerPeople(state).filter((p) => p.status === 'active' && filter(p)).sort((a, b) => (a.id < b.id ? -1 : 1));
  return list.length ? rng.pick(list) : null;
}

// ---------- weekly tick ----------

export function tick(state, data, ctx) {
  ensure(state);
  const C = ccfg(data);
  const people = playerPeople(state);

  // crew-exchange treaties (diplomacy): one of our astronauts trains with the partner
  for (const s of state.signals || []) {
    if (s?.type !== 'diplomacy/crewExchange' || !(s.parties || []).includes(state.playerId)) continue;
    const partner = (s.parties || []).find((x) => x !== state.playerId);
    const pick = people.filter((p) => p.role === 'astronaut' && p.status === 'active').sort((x, y) => (x.experience || 0) - (y.experience || 0))[0];
    if (!pick) continue;
    pick.experience = (pick.experience || 0) + 8;
    pick.morale = r1(clamp((pick.morale ?? 60) + 5, 0, 100));
    const name = state.actors?.[partner]?.short || partner || 'parceiro';
    addHistory(state, pick, `Intercâmbio de treinamento com ${name}.`);
    addNews(state, { headline: `${pick.name} vai treinar com a ${name}`, body: 'O acordo de intercâmbio de tripulações começa com simuladores e treino de sobrevivência.', tags: ['crew', 'diplomacy'], actors: [state.playerId, partner].filter(Boolean), importance: 1 });
  }

  // birthdays at the turn of the year
  if (state.turn > 0 && state.turn % 52 === 0) for (const p of people) if (alive(p) && p.status !== 'left') p.age = (p.age || 30) + 1;

  // payroll
  const payroll = people.filter(onPayroll).reduce((s, p) => s + (p.salaryM || 0), 0);
  if (payroll > 0) {
    const ok = canPay(state, payroll);
    pay(state, Math.round(payroll * 1000) / 1000, 'Folha da equipe', true);
    if (!ok) {
      for (const p of people) if (onPayroll(p)) { p.morale = r1(clamp(p.morale - 1.5, 0, 100)); p.loyalty = r1(clamp(p.loyalty - 1, 0, 100)); }
      if (!state.stats || !((state.stats['crew.lateSalaryNews'] ?? -99) > state.turn - 8)) {
        if (state.stats) state.stats['crew.lateSalaryNews'] = state.turn;
        addNews(state, { headline: 'Caixa no vermelho: equipe teme salários atrasados', tags: ['crew', 'budget'], actors: [state.playerId], importance: 2, icon: '💸' });
      }
    }
  }

  const leaders = people.filter((p) => p.status === 'active');
  const teamMoraleOf = (p) => Math.min(6, leaders.reduce((s, q) => s + (q !== p ? trait(data, q, 'teamMorale') : 0), 0));
  const techMorale = techBonus(state, state.playerId, 'crewMorale');
  const P = C.poach || {};

  for (const p of people) {
    if (!onPayroll(p)) continue;
    // recovery and training
    if (p.status === 'injured' && p.injuredUntil != null && p.injuredUntil <= state.turn) {
      p.status = 'active'; p.injuredUntil = null;
      addHistory(state, p, 'Voltou ao trabalho recuperada(o).'.replace('recuperada(o)', g(p, 'recuperada', 'recuperado')));
    }
    if (p.trainingUntil != null && p.trainingUntil <= state.turn) {
      const [a, b] = C.training?.skillGain || [3, 7];
      const gain = ctx.rng(`train:${p.id}`).int(a, b) * Math.max(0.2, 1 - p.skill / 120);
      p.skill = r1(Math.min(99, p.skill + gain));
      p.experience = r1((p.experience || 0) + 3);
      p.trainingUntil = null;
      addHistory(state, p, `Concluiu treinamento intensivo (+${r1(gain).toString().replace('.', ',')} de habilidade).`);
    }
    // morale drift
    const idle = p.role === 'astronaut' && p.ambition > 60 && state.turn - (p.lastFlightTurn ?? p.hiredTurn ?? 0) > 52 ? -10 : 0;
    const target = clamp((C.morale?.baseline ?? 60) + teamMoraleOf(p) + techMorale + trait(data, p, 'moraleDrift') * 4 + idle + (p.legend ? 8 : 0), 10, 95);
    p.morale = r1(clamp(p.morale + (target - p.morale) * 0.05, 0, 100));
    // loyalty drift
    const lt = clamp(50 + trait(data, p, 'loyaltyTarget') + (p.morale - 50) * 0.5 + (p.legend ? 10 : 0) - (p.ambition - 50) * 0.2, 5, 100);
    p.loyalty = r1(clamp(p.loyalty + (lt - p.loyalty) * 0.03, 0, 100));

    if (p.status !== 'active') continue;
    // training-ground injuries (rare)
    if (p.role === 'astronaut' && ctx.rng(`inj:${p.id}`).chance((C.injury?.weekly ?? 0.0008) * (1 + 10 * Math.max(0, trait(data, p, 'injuryChance'))))) {
      injure(state, data, p, 'Lesionada(o) em treinamento');
      continue;
    }
    if (assigned(state, p.id)) continue; // nobody walks out of a scheduled mission
    // poaching by rivals
    if (p.loyalty < (P.walkoutLoyalty ?? 12)) {
      const rival = pickRival(state, ctx.rng(`walk:${p.id}`));
      leave(state, data, p, rival, `Pediu demissão e foi para ${actorName(state, rival)}.`);
      addNews(state, { headline: `${p.name} abandona a agência rumo à ${actorName(state, rival)}`, tags: ['crew', 'rival'], actors: [state.playerId, rival].filter(Boolean), importance: 2, icon: '🚪' });
      continue;
    }
    if (p.loyalty < (P.loyaltyBelow ?? 42) && p.ambition > (P.ambitionAbove ?? 55) && !state.decisions.some((d) => d.kind === 'crew/poach' && d.payload?.crewId === p.id)) {
      const chance = (P.weeklyChance ?? 0.006) * traitMult(data, p, 'leaveChance') * (p.legend || p.skill > 80 ? 2 : 1);
      const rng = ctx.rng(`poach:${p.id}`);
      if (rng.chance(chance)) pushPoach(state, data, p, pickRival(state, rng));
    }
  }

  // retirement (quarterly)
  const R = C.retire || {};
  if (state.turn > 0 && state.turn % (R.checkEvery ?? 13) === 0) {
    for (const p of people) {
      if (p.status !== 'active' || assigned(state, p.id)) continue;
      const limit = p.role === 'astronaut' ? R.astronautAge ?? 54 : R.age ?? 60;
      let chance = p.age >= limit ? (R.chance ?? 0.12) * (1 + (p.age - limit) * 0.3) : 0;
      if (p.legend && p.missions >= 5) chance += 0.04;
      chance *= 1 + trait(data, p, 'retireChance');
      if (chance > 0 && ctx.rng(`retire:${p.id}`).chance(chance)) retire(state, data, p);
    }
  }
}

function retire(state, data, p) {
  p.status = 'retired';
  p.retiredTurn = state.turn;
  addHistory(state, p, `Aposentou-se aos ${p.age} anos, com ${p.missions} missões.`);
  addNews(state, {
    headline: `${p.name} se aposenta${p.legend ? ' como lenda' : ''}`,
    body: `${roleLabel(data, p)}, ${p.missions} missões na agência.`,
    tags: ['crew'], actors: [state.playerId], importance: p.legend ? 2 : 1, icon: '🎖️',
  });
}

function pickRival(state, rng) {
  const ids = Object.keys(state.actors || {}).filter((id) => id !== state.playerId).sort();
  if (!ids.length) return null;
  return rng.weighted(ids, (id) => Math.sqrt(state.actors[id]?.budget || 1000)) || ids[0];
}

function pushPoach(state, data, p, rival) {
  const P = ccfg(data).poach || {};
  const bonus = Math.round(p.salaryM * (P.counterBonusWeeks ?? 6) * 100) / 100;
  const raise = Math.round((P.counterRaise ?? 0.4) * 100);
  const afford = canPay(state, bonus);
  pushDecision(state, {
    kind: 'crew/poach',
    title: `Proposta para ${p.name}`,
    body: `A ${actorName(state, rival)} ofereceu a ${p.name} um cargo maior e salário melhor. ${g(p, 'Ela', 'Ele')} está dividid${g(p, 'a', 'o')}: lealdade ${Math.round(p.loyalty)}, ambição ${Math.round(p.ambition)}.`,
    portrait: { crewId: p.id },
    choices: [
      { id: 'counter', label: 'Cobrir a oferta', preview: `+${raise}% de salário, US$ ${bonus} mi de bônus, lealdade sobe`, disabled: !afford, reason: afford ? undefined : 'Caixa insuficiente' },
      { id: 'release', label: 'Deixar ir', preview: `${p.name} vai para a ${actorName(state, rival)}` },
    ],
    urgency: 2,
    expiresTurn: state.turn + 3,
    defaultChoice: 'release',
    payload: { crewId: p.id, rivalId: rival, bonus },
  });
}

// ---------- actions ----------

function hire(state, data, action) {
  ensure(state);
  const cand = currentCandidates(state, data).find((c) => c.id === action.candidateId);
  if (!cand) return { ok: false, error: 'candidato indisponível' };
  const max = ccfg(data).maxRoster ?? 18;
  if (playerPeople(state).filter(onPayroll).length >= max) return { ok: false, error: `equipe no limite (${max} pessoas)` };
  if (!canPay(state, cand.signingM)) return { ok: false, error: 'caixa insuficiente para a contratação' };
  pay(state, cand.signingM, `Contratação: ${cand.name}`);
  const p = { ...cand, hiredTurn: state.turn, history: [] };
  delete p.marketWeek; delete p.expiresTurn; delete p.signingM;
  addHistory(state, p, `Contratad${g(p, 'a', 'o')} pela agência.`);
  if (p.legacyOf && state.crew[p.legacyOf]) {
    addHistory(state, p, `Segue os passos de ${state.crew[p.legacyOf].name}.`);
    addHistory(state, state.crew[p.legacyOf], `${p.name} entra na agência seguindo seus passos.`);
  }
  state.crew[p.id] = p;
  addNews(state, {
    headline: p.legacyOf ? `Legado: ${p.name} chega à agência` : `${p.name} é ${g(p, 'a nova', 'o novo')} ${roleLabel(data, p).toLowerCase()} da agência`,
    tags: ['crew'], actors: [state.playerId], importance: p.legacyOf || p.star ? 2 : 1, icon: '🤝',
  });
  return { ok: true, crewId: p.id, cost: cand.signingM };
}

function fire(state, data, action) {
  const p = state.crew?.[action.crewId];
  if (!p || p.actorId !== state.playerId) return { ok: false, error: 'pessoa não encontrada' };
  if (!onPayroll(p)) return { ok: false, error: 'não faz mais parte da equipe' };
  if (assigned(state, p.id)) return { ok: false, error: 'escalada em missão ativa' };
  const severance = Math.round(p.salaryM * (ccfg(data).fireSeverenceWeeks ?? 8) * 100) / 100;
  pay(state, severance, `Rescisão: ${p.name}`, true);
  leave(state, data, p, null, `Demitid${g(p, 'a', 'o')} pela direção.`);
  for (const q of playerPeople(state)) if (onPayroll(q)) { q.morale = r1(clamp(q.morale - 3, 0, 100)); q.loyalty = r1(clamp(q.loyalty - 2, 0, 100)); }
  addNews(state, { headline: `${p.name} é desligad${g(p, 'a', 'o')} da agência`, tags: ['crew'], actors: [state.playerId], importance: p.legend ? 2 : 1, icon: '📦' });
  return { ok: true, cost: severance };
}

function train(state, data, action) {
  const p = state.crew?.[action.crewId];
  if (!p || p.actorId !== state.playerId) return { ok: false, error: 'pessoa não encontrada' };
  if (p.status !== 'active') return { ok: false, error: 'indisponível para treinar' };
  if (p.trainingUntil > state.turn) return { ok: false, error: 'já em treinamento' };
  if (inSpace(state, p.id) || missionsWith(state, p.id, ['scheduled', 'launch']).length) return { ok: false, error: 'escalada para voo próximo' };
  const T = ccfg(data).training || {};
  const cost = Math.round(p.salaryM * (T.costWeeks ?? 12) * 100) / 100;
  if (!canPay(state, cost)) return { ok: false, error: 'caixa insuficiente' };
  pay(state, cost, `Treinamento: ${p.name}`);
  const weeks = (T.weeks ?? 4) + trait(data, p, 'trainWeeks');
  p.trainingUntil = state.turn + weeks;
  p.morale = r1(clamp(p.morale + 3, 0, 100));
  addHistory(state, p, `Iniciou treinamento intensivo (${weeks} semanas).`);
  return { ok: true, cost, untilTurn: p.trainingUntil };
}

export const actions = { 'crew/hire': hire, 'crew/fire': fire, 'crew/train': train };

export const decisionHandlers = {
  'crew/poach': (state, data, decision, choiceId) => {
    const { crewId, rivalId, bonus } = decision.payload || {};
    const p = state.crew?.[crewId];
    if (!p || p.status !== 'active') return {};
    const P = ccfg(data).poach || {};
    if (choiceId === 'counter' && pay(state, bonus || 0, `Contraproposta: ${p.name}`)) {
      p.salaryM = Math.round(p.salaryM * (1 + (P.counterRaise ?? 0.4)) * 1000) / 1000;
      p.loyalty = r1(clamp(p.loyalty + (P.counterLoyalty ?? 25), 0, 100));
      p.morale = r1(clamp(p.morale + 10, 0, 100));
      p.ambition = r1(clamp(p.ambition - 10, 0, 100));
      addHistory(state, p, `Recusou proposta da ${actorName(state, rivalId)} depois de uma contraproposta.`);
      return { kept: true };
    }
    leave(state, data, p, rivalId, `Aceitou proposta da ${actorName(state, rivalId)}.`);
    addNews(state, {
      headline: `${p.name} troca a agência pela ${actorName(state, rivalId)}`,
      body: `${roleLabel(data, p)} com ${p.missions} missões leva know-how para o rival.`,
      tags: ['crew', 'rival'], actors: [state.playerId, rivalId].filter(Boolean), importance: 2, icon: '🚪',
    });
    return { kept: false };
  },
};

// ---------- queries ----------

const STATUS_ORDER = { active: 0, injured: 1, retired: 2, left: 3, dead: 4 };
const ROLE_ORDER = { flight_director: 0, astronaut: 1, engineer: 2 };

function view(state, data, p) {
  const T = traitsOf(data);
  const training = p.trainingUntil > state.turn;
  const space = inSpace(state, p.id);
  return {
    ...p,
    roleLabel: roleLabel(data, p),
    traitDetails: (p.traits || []).map((id) => ({ id, name: T[id]?.name || id, description: T[id]?.description || '' })),
    available: p.status === 'active' && !training && !space,
    busy: training ? 'training' : space ? 'space' : p.status === 'injured' ? 'injured' : null,
    inMission: assigned(state, p.id),
    trainCost: Math.round(p.salaryM * (ccfg(data).training?.costWeeks ?? 12) * 100) / 100,
  };
}

export const queries = {
  'crew/roster': (state, data) => playerPeople(state)
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || b.skill - a.skill)
    .map((p) => view(state, data, p)),
  'crew/candidates': (state, data) => currentCandidates(state, data).map((c) => ({ ...view(state, data, c), available: true, signingM: c.signingM, expiresTurn: c.expiresTurn })),
  'crew/memorial': (state) => (state.memorial || []).slice().reverse(),
  'crew/person': (state, data, id) => {
    const p = state.crew?.[id];
    if (p) return view(state, data, p);
    const c = String(id).startsWith('cand_') ? currentCandidates(state, data).find((x) => x.id === id) : null;
    return c ? view(state, data, c) : null;
  },
  'crew/available': (state, data, role) => availableCrew(state, role).map((p) => view(state, data, p)),
  'crew/summary': (state) => {
    const ps = playerPeople(state);
    const active = ps.filter(onPayroll);
    return {
      active: active.length,
      byRole: Object.fromEntries(ROLES.map((r) => [r, active.filter((p) => p.role === r).length])),
      payrollWeekly: Math.round(active.reduce((s, p) => s + (p.salaryM || 0), 0) * 1000) / 1000,
      morale: active.length ? Math.round(active.reduce((s, p) => s + p.morale, 0) / active.length) : 0,
      legends: ps.filter((p) => p.legend).length,
      fallen: (state.memorial || []).length,
    };
  },
  'crew/commandPoints': (state, data, crewSel) => commandPointsFor(state, data, crewSel),
  'crew/modifier': (state, data, crewSel, context) => crewModifier(state, data, crewSel, context),
};

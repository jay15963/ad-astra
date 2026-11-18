// The Eco mystery and the jan/3000 ending (module "eco", slice state.eco). Contract: docs/EXPANSION.md §9, GDD
// "O mistério de fundo: o Eco". Content: data/core/eco.json. Pure JS, deterministic (ctx.rng only), JSON state.
//
// state.eco = {
//   pieces: [{id, eraId, turn, via: 'player'|'world'|'arquivo', choice?}],   // the Eco fragments the world has seen
//   lean: {contato, silencio, heranca},                                       // where the agency leans (choices, drift)
//   colegio: {rel, born, founder, actorId, beats: {beatId: turn}},            // the Colégio Silêncio storyline
//   drift: {milestoneId: 1}, families: {surname: {...}}, chron: [{era, name, rank, of}],
//   epilogue: null | {ending, tone, met, ai, coherent, year, paras, legacy, close}
// }
// - Active only in scenarios that end with the final event (the campaign, O Grande Silêncio) or carry `eco: true`;
//   the Corrida Lunar never gets the slice (its saves and golden runs are untouched).
// - One piece opens per tick at most, only in its own era, once minYear passed and a trigger milestone was reached
//   by anyone (or fallbackYear came). A main piece never goes missing: if its era ends without it, it enters the
//   archives silently (no card). Pieces of eras before the start of the scenario are archived at init.
// - Each piece is a non-blocking card (26 weeks, default choice on expiry) whose choice shifts `lean` and the
//   Colégio's relation; with no player left, the world picks by its own lean.
// - The final tick pushes the blocking 'ending/final' card itself (engine.pushEnding is skipped through
//   clock.endingPushed), with requirements met/unmet and a preview coloured by `lean`. The engine's built-in
//   handler resolves it; onGameEnd composes the epilogue (or the world's ending, if the player left before 3000).

import { addNews, pushDecision, changeActor, expiryIn, clamp } from '../core/helpers.js';
import { yearOf, eraAt, eraById } from '../core/time.js';

export const meta = { maxDt: 52 };
export const ENDING_IDS = ['contato', 'silencio', 'heranca'];
const TONES = ['fragil', 'incerto', 'pleno'];

const eco = (data) => data?.eco || null;
const cfg = (data) => ({ cardWeeks: 26, leanCap: 60, colegioRel: [-100, 100], familyCap: 40, playerDouble: 2, ...(eco(data)?.config || {}) });
const piecesOf = (data) => (Array.isArray(eco(data)?.pieces) ? eco(data).pieces : []);
const pieceDef = (data, id) => piecesOf(data).find((p) => p.id === id) || null;
const beatsOf = (data) => (Array.isArray(eco(data)?.colegio?.beats) ? eco(data).colegio.beats : []);

/** Is the Eco running in this scenario? */
export function isActive(data) {
  const sc = data?.scenario || {};
  if (!eco(data)) return false;
  if (sc.eco === false) return false;
  return sc.eco === true || sc.kind === 'campaign' || sc.ending?.type === 'final';
}

function fresh() {
  return {
    pieces: [], lean: { contato: 0, silencio: 0, heranca: 0 },
    colegio: { rel: 0, born: null, founder: null, actorId: null, beats: {} },
    drift: {}, families: {}, chron: [], epilogue: null,
  };
}

/** The slice, created (tolerantly completed for migrated saves) when the Eco is active; null otherwise. */
function slice(state, data) {
  if (!state.eco) {
    if (!isActive(data)) return null;
    state.eco = fresh();
  }
  const e = state.eco;
  if (!Array.isArray(e.pieces)) e.pieces = [];
  e.lean = { contato: 0, silencio: 0, heranca: 0, ...(e.lean || {}) };
  e.colegio = { rel: 0, born: null, founder: null, actorId: null, beats: {}, ...(e.colegio || {}) };
  e.colegio.beats ||= {};
  e.drift ||= {};
  e.families ||= {};
  if (!Array.isArray(e.chron)) e.chron = [];
  if (e.epilogue === undefined) e.epilogue = null;
  return e;
}

const eraNum = (id) => Number(String(id || '').replace(/\D/g, '')) || 0;
const has = (e, id) => e.pieces.some((p) => p.id === id);
const playerAlive = (state) => !!state.actors?.[state.playerId] && !state.gameOver;
const yearAtTurn = (state, t) => yearOf(state, t);

/** Who reached a milestone: {actorId|null, player: bool} or null when nobody did (yet). */
export function achieved(state, id) {
  if (!id) return null;
  const f = state.firsts?.[id];
  if (f) return { actorId: f.actorId ?? null, player: f.actorId === state.playerId };
  if (state.firstsHistory?.[id]) return { actorId: null, player: false };
  return null;
}

function addLean(state, data, delta, mult = 1) {
  const e = state.eco;
  const cap = cfg(data).leanCap;
  for (const k of ENDING_IDS) {
    const d = Number(delta?.[k]) || 0;
    if (d) e.lean[k] = clamp(Math.round((e.lean[k] + d * mult) * 10) / 10, 0, cap);
  }
}

function addRel(state, data, d) {
  if (!Number.isFinite(d) || !d) return;
  const [lo, hi] = cfg(data).colegioRel;
  state.eco.colegio.rel = clamp(state.eco.colegio.rel + d, lo, hi);
}

const EFFECT_FIELDS = ['support', 'reputation', 'cash', 'prestige'];
function applyEffects(state, effects) {
  if (!effects || !state.actors?.[state.playerId]) return;
  for (const f of EFFECT_FIELDS) if (Number.isFinite(effects[f]) && effects[f]) changeActor(state, state.playerId, f, effects[f]);
}

/** Dominant lean: an ending id, or null when nothing leans (all zero) or the top two tie. */
export function dominantLean(lean) {
  const l = lean || {};
  const sorted = ENDING_IDS.map((id) => [id, Number(l[id]) || 0]).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] <= 0 || sorted[0][1] === sorted[1][1]) return null;
  return sorted[0][0];
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------

/** Fill {key} markers; unknown markers are removed (never leak "{x}" to the player). */
export function fill(tpl, vars = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : '')).replace(/\s{2,}/g, ' ').trim();
}

const firstWord = (s) => String(s || '').split(' ')[0];
function surnameOf(data, p) {
  const parts = String(p?.name || '').split(' ').filter(Boolean);
  if (parts.length < 2) return parts[0] || null;
  return (data?.crew?.surnameFirst || []).includes(p.culture) ? parts[0] : parts.slice(1).join(' ');
}

/** "uma era" / "3 eras". */
export const plural = (n, one, many, article) => (n === 1 ? `${article} ${one}` : `${n} ${many}`);

/** Pt-BR list: "a", "a e b", "a, b e c". */
export function listPt(items) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`;
}

/** Milestone label from the data the sim has (UI passes its own richer labels to composeEpilogue). */
export function milestoneLabel(data, id) {
  const base = String(id).split(':')[0];
  return eco(data)?.milestoneLabels?.[base] || data?.calendar?.milestoneLabels?.[base] || data?.bodies?.milestoneLabels?.[base] || data?.events?.milestones?.[base]
    || data?.actors?.milestones?.[base] || base.replace(/_/g, ' ');
}

/** A name for {person}: the Colégio's founder, or someone from the player's engineering team. */
function personFor(state, data, rng, piece) {
  if (piece === 'founder') {
    if (state.eco.colegio.founder) return state.eco.colegio.founder;
    const pool = eco(data)?.colegio?.founders || ['Irene Valdés'];
    let name = rng.pick(pool);
    // a legacy surname coming back centuries later (GDD "Legados")
    const fams = Object.values(state.eco.families || {}).sort((a, b) => (b.gen - a.gen) || (a.from - b.from));
    if (fams.length && rng.next() < 0.6) name = `${firstWord(name)} ${fams[0].surname}`;
    return name;
  }
  const staff = Object.values(state.crew || {}).filter((p) => p && p.actorId === state.playerId && p.status === 'active' && p.role === 'engineer')
    .sort((a, b) => (b.skill || 0) - (a.skill || 0) || (a.id < b.id ? -1 : 1));
  if (staff[0]?.name) return staff[0].name;
  return rng.pick(eco(data)?.colegio?.founders || ['Tomás Ilunga']);
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------------------

/** Archive the main piece of every era before `eraId` that never opened (no card, no news). */
function archivePast(state, data, eraId, turn) {
  const e = state.eco;
  const n = eraNum(eraId);
  for (const p of piecesOf(data)) {
    if (!p.main || eraNum(p.era) >= n || has(e, p.id)) continue;
    e.pieces.push({ id: p.id, eraId: p.era, turn, via: 'arquivo' });
    if (p.colegio === 'born' && e.colegio.born == null) e.colegio.born = turn;
  }
}

/** The next piece of the era that may open now, with how it was triggered; null if none. */
export function nextPiece(state, data, eraId, year) {
  const e = state.eco;
  const list = piecesOf(data).filter((p) => p.era === eraId && !has(e, p.id)).sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const p of list) {
    if (p.after && !has(e, p.after)) continue;
    const t = p.trigger || {};
    if (Number.isFinite(t.minYear) && year < t.minYear) continue;
    let hit = null;
    for (const m of t.milestones || []) {
      const a = achieved(state, m);
      if (a && (!hit || (a.player && !hit.player))) hit = { ...a, milestone: m };
    }
    if (hit) return { piece: p, via: hit.player ? 'player' : 'world', milestone: hit.milestone };
    if (Number.isFinite(t.fallbackYear) && year >= t.fallbackYear) return { piece: p, via: 'world', milestone: null };
  }
  return null;
}

function cardChoices(card) {
  return (card?.choices || []).map((c) => ({ id: c.id, label: c.label, preview: c.preview }));
}

function openPiece(state, data, ctx, found) {
  const e = state.eco;
  const p = found.piece;
  const turn = state.turn;
  const rng = ctx.rng(`piece:${p.id}`);
  const rec = { id: p.id, eraId: p.era, turn, via: found.via };
  e.pieces.push(rec);
  const vars = {};
  if (p.colegio === 'born') {
    e.colegio.born = turn;
    e.colegio.founder = personFor(state, data, rng, 'founder');
    vars.person = e.colegio.founder;
  }
  if (p.news?.headline) {
    addNews(state, { headline: fill(p.news.headline, vars), body: fill(p.news.body, vars), tags: ['eco'], importance: p.main ? 3 : 2, icon: 'eco' });
  }
  if (!p.card?.choices?.length) return;
  if (!playerAlive(state)) { worldChooses(state, data, rng, p.card, (c) => applyPieceChoice(state, data, p, rec, c)); return; }
  const def = p.card.defaultChoice || p.card.choices[0].id;
  pushDecision(state, {
    kind: 'eco/piece',
    title: p.title,
    body: fill(p.card.body, vars),
    choices: cardChoices(p.card),
    urgency: p.main ? 2 : 1,
    expiresTurn: expiryIn(ctx, cfg(data).cardWeeks),
    defaultChoice: def,
    payload: { pieceId: p.id, via: found.via },
  });
}

/** With no director to ask, the world chooses: weighted by its lean (plus one so every path stays possible). */
function worldChooses(state, data, rng, card, apply) {
  const lean = state.eco.lean;
  const w = (c) => 1 + ENDING_IDS.reduce((s, k) => s + (c.lean?.[k] > 0 ? (lean[k] || 0) : 0), 0);
  const pick = rng.weighted(card.choices, w) || card.choices[0];
  apply(pick);
}

function applyPieceChoice(state, data, p, rec, c, { expired = false } = {}) {
  const mult = rec.via === 'player' ? cfg(data).playerDouble : 1;
  addLean(state, data, c.lean, mult);
  addRel(state, data, c.colegio);
  if (!expired) applyEffects(state, c.effects);
  rec.choice = c.id;
  if (expired) rec.auto = true;
}

// ---------------------------------------------------------------------------------------------------------------
// Colégio Silêncio, drift, the final decade, families
// ---------------------------------------------------------------------------------------------------------------

function colegioActor(state) {
  for (const [id, a] of Object.entries(state.actors || {})) if (a?.archetype === 'colegio_silencio') return id;
  return null;
}

function yearColegio(state, data, ctx, year) {
  const e = state.eco;
  const C = e.colegio;
  // the lifecycle may give the Colégio a body of its own (actor-gen 'colegio_silencio', scripted, from 2600)
  if (!C.actorId) {
    const id = colegioActor(state);
    if (id) { C.actorId = id; if (C.born == null) C.born = state.turn; }
  }
  if (C.born == null) return;
  const rng = ctx.rng(`colegio:${year}`);
  for (const b of beatsOf(data)) {
    if (C.beats[b.id] != null) continue;
    if (year < b.from || year > b.to) continue;
    if (Number.isFinite(b.minRel) && C.rel < b.minRel) continue;
    if (Number.isFinite(b.maxRel) && C.rel > b.maxRel) continue;
    const due = year >= b.to || (b.actor && C.actorId) || rng.next() < (b.chance ?? 0.05);
    if (!due) continue;
    fireBeat(state, data, ctx, b, rng);
    return; // one beat per year
  }
}

function fireBeat(state, data, ctx, b, rng) {
  const e = state.eco;
  e.colegio.beats[b.id] = state.turn;
  const vars = { person: personFor(state, data, rng, b.id) };
  if (b.news?.headline) addNews(state, { headline: fill(b.news.headline, vars), body: fill(b.news.body, vars), tags: ['eco', 'colegio'], importance: 2, icon: 'eco', actors: e.colegio.actorId ? [e.colegio.actorId] : [] });
  addLean(state, data, b.lean);
  applyEffects(state, b.effects);
  if (!b.card?.choices?.length) return;
  if (!playerAlive(state)) {
    worldChooses(state, data, rng, b.card, (c) => { addLean(state, data, c.lean); addRel(state, data, c.colegio); });
    return;
  }
  pushDecision(state, {
    kind: 'eco/colegio',
    title: b.title,
    body: fill(b.card.body, vars),
    choices: cardChoices(b.card),
    urgency: 1,
    expiresTurn: expiryIn(ctx, cfg(data).cardWeeks),
    defaultChoice: b.card.defaultChoice || b.card.choices[0].id,
    payload: { beatId: b.id },
  });
}

function yearDrift(state, data) {
  const e = state.eco;
  for (const d of eco(data)?.drift || []) {
    if (!d?.milestone || e.drift[d.milestone]) continue;
    const a = achieved(state, d.milestone);
    if (!a) continue;
    e.drift[d.milestone] = 1;
    addLean(state, data, d.lean, a.player ? cfg(data).playerDouble : 1);
    if (d.headline) addNews(state, { headline: d.headline, tags: ['eco'], importance: 1, icon: 'eco' });
  }
}

function yearSilence(state, data, year) {
  const s = eco(data)?.silence;
  if (!s?.lines?.length || !Number.isFinite(s.fromYear)) return;
  const i = year - s.fromYear;
  if (i < 0 || i >= s.lines.length) return;
  addNews(state, { headline: s.lines[i], tags: ['eco', 'silencio'], importance: 2, icon: 'eco' });
}

/** Families of the player's people: legacy chains (crew.legacyOf) kept as {surname: {gen, from, to, first, last, fallen}}. */
function yearFamilies(state, data) {
  const e = state.eco;
  const crew = state.crew || {};
  const memorial = new Map();
  for (const m of state.memorial || []) if (m?.crewId) memorial.set(m.crewId, m);
  for (const p of Object.values(crew)) {
    if (!p?.legacyOf || p.actorId !== state.playerId) continue;
    // follow the chain back to its root (compaction keeps every legacyOf target)
    let root = p;
    let gen = 1;
    const seen = new Set([p.id]);
    while (root.legacyOf && crew[root.legacyOf] && !seen.has(root.legacyOf) && gen < 40) { seen.add(root.legacyOf); root = crew[root.legacyOf]; gen++; }
    const surname = surnameOf(data, p);
    if (!surname || gen < 2) continue;
    const from = yearAtTurn(state, root.hiredTurn ?? 0);
    const to = yearAtTurn(state, p.hiredTurn ?? state.turn);
    const cur = e.families[surname];
    const fallen = memorial.get(root.id);
    if (cur && cur.gen > gen) continue;
    if (cur && cur.gen === gen && cur.to >= to) continue;
    e.families[surname] = { surname, gen, from: Math.min(from, cur?.from ?? from), to, first: root.name, last: p.name,
      fallen: fallen ? yearAtTurn(state, fallen.turn ?? 0) : (cur?.fallen ?? null) };
  }
  const keys = Object.keys(e.families);
  const cap = cfg(data).familyCap;
  if (keys.length > cap) {
    const drop = Object.values(e.families).sort((a, b) => (a.gen - b.gen) || (a.to - b.to)).slice(0, keys.length - cap);
    for (const f of drop) delete e.families[f.surname];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Final event
// ---------------------------------------------------------------------------------------------------------------

/** Player-founded worlds (C10 colonies when present, else the colony "firsts" of the agency). */
function colonyNames(state, data) {
  const c = state.colonies;
  const raw = !c ? [] : Array.isArray(c) ? c : Array.isArray(c.list) ? c.list : Object.values(c.list && typeof c.list === 'object' ? c.list : {});
  const mine = raw.filter((x) => x && (x.name || x.id) && (!x.ownerId && !x.owner ? true : (x.ownerId || x.owner) === state.playerId));
  return mine.map((x) => x.name || x.id);
}

/** Requirement status for the three endings: {contato: [{id, label, met}], …}. Pure. */
export function requirements(state, data) {
  const e = state.eco || fresh();
  const out = {};
  for (const id of ENDING_IDS) {
    out[id] = (eco(data)?.endings?.[id]?.requirements || []).map((r) => {
      let met = false;
      if (r.type === 'milestone') met = !!achieved(state, r.milestone);
      else if (r.type === 'pieces') met = e.pieces.length >= (r.n || 0);
      else if (r.type === 'colegio') met = e.colegio.born != null && (Number.isFinite(r.min) ? e.colegio.rel >= r.min : true) && (Number.isFinite(r.max) ? e.colegio.rel <= r.max : true);
      else if (r.type === 'families') met = Object.keys(e.families).length >= (r.n || 1);
      else if (r.type === 'colonies') met = colonyNames(state, data).length >= (r.n || 1);
      else if (r.type === 'lean') met = dominantLean(e.lean) === (r.ending || id);
      return { id: r.id, label: r.label, met };
    });
  }
  return out;
}

/** 'pleno' (all met), 'incerto' (some), 'fragil' (none). */
export function toneOf(reqs) {
  const n = reqs.length;
  const met = reqs.filter((r) => r.met).length;
  if (!n || met === n) return 'pleno';
  return met > 0 ? 'incerto' : 'fragil';
}

/** The three choices of the final card, each with requirements and a lean-coloured preview. Pure. */
export function endingChoices(state, data) {
  const reqs = requirements(state, data);
  const lean = dominantLean(state.eco?.lean);
  return ENDING_IDS.map((id) => {
    const E = eco(data)?.endings?.[id] || {};
    const tone = toneOf(reqs[id]);
    const previewTone = E.previews?.[tone] || E.preview || '';
    return {
      id, label: E.label || id, tone, leaning: lean === id,
      preview: lean === id ? `${previewTone} É para onde a agência vem se inclinando.` : previewTone,
      requirements: reqs[id],
    };
  });
}

function pushFinal(state, data) {
  const F = eco(data)?.final || {};
  const lean = dominantLean(state.eco.lean);
  const leanLine = F.leanLines?.[lean || 'none'] || '';
  state.clock.endingPushed = true;
  pushDecision(state, {
    kind: 'ending/final',
    title: F.title || data?.ending?.title || 'O Grande Silêncio',
    body: [F.body || data?.ending?.body || '', leanLine].filter(Boolean).join(' '),
    choices: endingChoices(state, data),
    urgency: 3,
    blocking: true,
    payload: { turn: state.turn, lean: { ...state.eco.lean }, dominant: lean },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Epilogue
// ---------------------------------------------------------------------------------------------------------------

/** Facts of the player's 1,050 years, as pt-BR lines (data/core/eco.json "legacy"). Pure. */
export function legacyLines(state, data, { labelOf = (id) => milestoneLabel(data, id) } = {}) {
  const L = eco(data)?.legacy || {};
  const t = (k, v) => (L[k]?.tpl ? fill(L[k].tpl, v) : null);
  const pid = state.playerId;
  const a = state.actors?.[pid] || state.lifecycle?.tombstones?.[pid] || {};
  const e = state.eco || fresh();
  const out = [];
  const name = a.name || a.short || pid;
  const lin = (Array.isArray(data?.lineages) ? data.lineages : data?.lineages?.lineages || []).find((x) => x?.id === pid);
  const yearIn = (d) => (Number.isFinite(d) ? d : Number.isFinite(d?.year) ? d.year : null);
  const founded = yearIn(a.born) ?? yearIn(a.founded) ?? yearIn(lin?.born) ?? state.startYear;
  const erasLived = new Set([...(state.eraHistory || []).map((h) => h.eraId), state.clock?.eraId].filter(Boolean)).size || 1;
  const eras = plural(erasLived, 'era', 'eras', 'uma');
  out.push(founded < state.startYear ? t('agencyOld', { agencia: name, ano: founded, eras, inicio: state.startYear }) : t('agency', { agencia: name, ano: founded, eras }));
  const names = [...new Set([...e.chron.map((c) => c.name), a.name].filter(Boolean))];
  if (names.length > 1) out.push(t('renamed', { nomes: listPt(names.slice(-5)) }));
  const leads = (state.eraHistory || []).filter((h) => h.standings?.[0]?.id === pid).length;
  if (leads) out.push(t('league', { lideres: leads === 1 ? 'uma' : String(leads) }));
  const firsts = Object.entries(state.firsts || {}).filter(([id, f]) => f?.actorId === pid && !id.includes(':'))
    .map(([id, f]) => ({ id, turn: f.turn ?? 0 })).sort((x, y) => x.turn - y.turn);
  if (firsts.length) {
    out.push(t('firsts', { n: firsts.length, primeiro: labelOf(firsts[0].id), ano1: yearAtTurn(state, firsts[0].turn),
      ultimo: labelOf(firsts[firsts.length - 1].id), ano2: yearAtTurn(state, firsts[firsts.length - 1].turn) }));
  } else {
    const flown = (state.missions || []).filter((m) => m?.result).length + (state.missionsArchive?.length || 0);
    out.push(t('noFirsts', { missoes: plural(flown, 'missão', 'missões', 'uma') }));
  }
  const mem = (state.memorial || []).filter((m) => m?.name);
  const memYear = (m) => (Number.isFinite(m.year) ? m.year : yearAtTurn(state, m.turn ?? 0));
  if (mem.length > 1) out.push(t('memorial', { n: mem.length, primeiro: mem[0].name, ano1: memYear(mem[0]), ultimo: mem[mem.length - 1].name, ano2: memYear(mem[mem.length - 1]) }));
  else if (mem.length === 1) out.push(t('memorialOne', { primeiro: mem[0].name, ano1: memYear(mem[0]) }));
  else out.push(t('noMemorial', {}));
  const fams = Object.values(e.families).sort((x, y) => (y.gen - x.gen) || (x.from - y.from)).slice(0, 2);
  for (const f of fams) {
    out.push(t('family', { sobrenome: f.surname, geracoes: plural(f.gen, 'geração', 'gerações', 'uma'), ano1: f.from, ano2: f.to, primeiro: f.first, ultimo: f.last }));
    if (f.fallen != null) out.push(t('familyFallen', { ultimo: f.last, primeiro: f.first, ano1: f.fallen }));
  }
  const cols = colonyNames(state, data);
  if (cols.length) out.push(t('colonies', { n: cols.length, nomes: listPt(cols.slice(0, 4)) }));
  // a piece that entered the archives (the game started in a later era) dates from its own era, not the archiving turn
  const pieceYear = (rec) => {
    const def = rec && piecesOf(data).find((p) => p.id === rec.id);
    return rec?.via === 'arquivo' && Number.isFinite(def?.trigger?.minYear) ? def.trigger.minYear : yearAtTurn(state, rec?.turn ?? 0);
  };
  if (e.pieces.length) out.push(t('eco', { total: piecesOf(data).length, n: e.pieces.length, ano1: pieceYear(e.pieces[0]) }));
  if (e.colegio.born != null) {
    const bornRec = e.pieces.find((p) => piecesOf(data).find((d) => d.id === p.id)?.colegio === 'born');
    const bornYear = bornRec?.via === 'arquivo' ? pieceYear(bornRec) : yearAtTurn(state, e.colegio.born);
    const anos = Math.max(1, yearAtTurn(state, state.turn) - bornYear);
    out.push(t(e.colegio.rel >= 20 ? 'colegioFriend' : e.colegio.rel <= -20 ? 'colegioFoe' : 'colegioNeutral', { anos: plural(anos, 'ano', 'anos', 'um') }));
  }
  return out.filter(Boolean);
}

/**
 * Epilogue of an ending: {ending, label, tone, met, total, coherent, dominant, ai, year, paras, legacy, close, headline}.
 * Pure (reads state, data). `ai` = the world's ending (the player left before 3000).
 */
export function composeEpilogue(state, data, endingId, { ai = false, labelOf } = {}) {
  const id = ENDING_IDS.includes(endingId) ? endingId : (dominantLean(state.eco?.lean) || 'heranca');
  const E = eco(data)?.endings?.[id] || {};
  const reqs = requirements(state, data)[id] || [];
  const tone = toneOf(reqs);
  const dominant = dominantLean(state.eco?.lean);
  const coherent = dominant == null || dominant === id;
  // the world's ending (director gone) has its own paragraph: the tone texts narrate the agency acting in 3000
  const paras = [(ai && E.worldPara) || E.paras?.[tone] || data?.ending?.choices?.find?.((c) => c.id === id)?.text || ''];
  const leanLine = dominant == null ? null : coherent ? E.coherent : E.turn;
  if (leanLine && !ai) paras.push(leanLine);
  const legacy = legacyLines(state, data, labelOf ? { labelOf } : {});
  if (ai) {
    const L = eco(data)?.legacy?.gone?.tpl;
    const goneYear = yearAtTurn(state, state.gameOver?.turn ?? state.turn);
    if (L) legacy.unshift(fill(L, { ano: goneYear }));
  }
  return {
    ending: id, label: E.label || id, tone, met: reqs.filter((r) => r.met).length, total: reqs.length,
    requirements: reqs, coherent, dominant, ai, year: yearAtTurn(state, state.turn),
    paras: paras.filter(Boolean), legacy, close: E.close || '', headline: E.world || null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Module interface
// ---------------------------------------------------------------------------------------------------------------

export function init(state, data, ctx) {
  const e = slice(state, data);
  if (!e) return;
  // a scenario that starts mid-history already knows the main pieces of the eras before it
  archivePast(state, data, eraAt(data, yearOf(state, state.turn))?.id, state.turn);
}

export function tick(state, data, ctx = {}) {
  const e = slice(state, data);
  if (!e || state.gameOver) return;
  const prevTurn = Number.isFinite(ctx.prevTurn) ? ctx.prevTurn : state.turn;
  const dt = Number.isFinite(ctx.dt) && ctx.dt > 0 ? ctx.dt : 1;
  const lastWeek = prevTurn + dt - 1;
  const year = yearOf(state, lastWeek);
  const eraId = eraAt(data, year)?.id ?? ctx.eraId;
  archivePast(state, data, eraId, state.turn);
  const found = nextPiece(state, data, eraId, year);
  if (found) openPiece(state, data, ctx, found);
  const clock = state.clock;
  if (clock && clock.finalTurn != null && !clock.endingPushed && prevTurn + dt >= clock.finalTurn) pushFinal(state, data);
}

export function onYear(state, data, ctx = {}) {
  const e = slice(state, data);
  if (!e || state.gameOver) return;
  const year = yearOf(state, state.turn);
  yearDrift(state, data);
  yearFamilies(state, data);
  yearColegio(state, data, ctx, year);
  yearSilence(state, data, year);
}

export function onEraEnd(state, data, ctx, info = {}) {
  const e = slice(state, data);
  if (!e) return;
  // the closing era's main piece never goes missing
  const nextN = eraNum(info.to);
  if (nextN) archivePast(state, data, info.to, state.turn);
  const pid = state.playerId;
  const a = state.actors?.[pid];
  const ranked = Object.entries(state.actors || {}).sort((x, y) => (Number(y[1]?.prestigeEra) || 0) - (Number(x[1]?.prestigeEra) || 0));
  const rank = ranked.findIndex(([id]) => id === pid) + 1;
  e.chron.push({ era: info.from ?? null, name: a?.name ?? null, rank: rank || null, of: ranked.length });
  if (e.chron.length > 8) e.chron.splice(0, e.chron.length - 8);
}

export function onGameEnd(state, data) {
  const e = slice(state, data);
  if (!e || e.epilogue) return;
  const go = state.gameOver || {};
  const ai = go.reason !== 'ending';
  if (ai && go.reason === 'end') return; // a short scenario reached its own end: no world ending to tell
  const ep = composeEpilogue(state, data, ai ? dominantLean(e.lean) : go.ending, { ai });
  if (!ai && ep.paras[0] && state.gameOver) state.gameOver.summary = ep.paras[0]; // end screen/logs match ending.js
  e.epilogue = { ending: ep.ending, tone: ep.tone, met: ep.met, ai, coherent: ep.coherent, year: ep.year, paras: ep.paras, legacy: ep.legacy, close: ep.close };
  if (ai && ep.headline) {
    addNews(state, { headline: `Epílogo: ${ep.headline}`, body: ep.paras[0] || '', tags: ['eco', 'epilogo'], importance: 3, icon: 'eco' });
  }
}

/** Keep the slice small (§10): pieces ≤ 30, beats ≤ 20, families capped by yearFamilies, chron ≤ 8. */
export function compact(state, data) {
  const e = state.eco;
  if (!e) return;
  if (e.pieces.length > 30) e.pieces.splice(0, e.pieces.length - 30);
  const beats = Object.keys(e.colegio?.beats || {});
  if (beats.length > 20) for (const k of beats.slice(0, beats.length - 20)) delete e.colegio.beats[k];
}

export const decisionHandlers = {
  'eco/piece': (state, data, dec, choiceId, ctx = {}) => {
    const e = slice(state, data);
    const p = pieceDef(data, dec.payload?.pieceId);
    if (!e || !p) return { ok: true };
    const rec = e.pieces.find((x) => x.id === p.id) || { id: p.id, eraId: p.era, turn: state.turn, via: dec.payload?.via || 'world' };
    if (!e.pieces.includes(rec)) e.pieces.push(rec);
    const c = (p.card?.choices || []).find((x) => x.id === choiceId) || (p.card?.choices || [])[0];
    if (!c) return { ok: true };
    applyPieceChoice(state, data, p, rec, c, { expired: !!ctx.expired });
    return { ok: true, message: `Eco: ${c.label}` };
  },
  'eco/colegio': (state, data, dec, choiceId) => {
    const e = slice(state, data);
    const b = beatsOf(data).find((x) => x.id === dec.payload?.beatId);
    if (!e || !b) return { ok: true };
    const c = (b.card?.choices || []).find((x) => x.id === choiceId) || (b.card?.choices || [])[0];
    if (!c) return { ok: true };
    addLean(state, data, c.lean);
    addRel(state, data, c.colegio);
    applyEffects(state, c.effects);
    return { ok: true, message: `Colégio: ${c.label}` };
  },
};

/** The Eco piece of an era for the era scene (§2.4 card 4): {id, title, line, via} or null. */
export function eraFragment(state, data, eraId) {
  const list = (state?.eco?.pieces || []).filter((p) => p.eraId === eraId);
  if (!list.length) return null;
  const rec = list.find((p) => pieceDef(data, p.id)?.main) || list[list.length - 1];
  const d = pieceDef(data, rec.id);
  return d ? { id: rec.id, title: d.title, line: d.line || '', via: rec.via } : null;
}

/** UI summary: pieces with titles and years, lean, the Colégio. */
export function summary(state, data) {
  const e = state?.eco;
  if (!e) return null;
  return {
    total: piecesOf(data).length,
    pieces: e.pieces.map((p) => ({ ...p, year: yearAtTurn(state, p.turn), title: pieceDef(data, p.id)?.title || p.id, line: pieceDef(data, p.id)?.line || '', era: eraById(data, p.eraId)?.n ?? null })),
    lean: { ...e.lean }, dominant: dominantLean(e.lean),
    colegio: e.colegio.born != null ? { rel: e.colegio.rel, since: yearAtTurn(state, e.colegio.born), founder: e.colegio.founder, actorId: e.colegio.actorId } : null,
    families: Object.values(e.families).sort((a, b) => b.gen - a.gen),
    epilogue: e.epilogue,
  };
}

export const queries = {
  'eco/summary': (state, data) => summary(state, data),
  'eco/eraFragment': (state, data, eraId) => eraFragment(state, data, eraId),
  'eco/endingChoices': (state, data) => (state.eco ? endingChoices(state, data) : null),
  'eco/epilogue': (state, data, endingId, opts) => (state.eco ? composeEpilogue(state, data, endingId ?? state.gameOver?.ending, opts || {}) : null),
};

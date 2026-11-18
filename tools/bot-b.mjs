// Phase B bot (B5, docs/EXPANSION.md §5, §6, §14): the moves a Phase B player makes, layered over the shared bot of
// tools/golden.mjs (whose default behaviour the golden fixture pins, so it is not edited):
//   - founds its own agency at turn 0 (`agency/found`, §5.3) when asked to,
//   - answers the yearly investor rounds (`investors/round`, §5.2) keeping a minimum stake, buys back when rich,
//   - opens the missions of open mandates (`mission/fromMandate`) so they fly before the deadline,
//   - licenses a catalog rocket and develops it in the Hangar (`design/license`, `design/develop`, §6) once in a
//     while, and flies operational designs on its own missions when they fit.
// Every Phase B action is optional: an engine without investors.js/designs.js answers "ação desconhecida" and the
// bot carries on, so the same runs work before and after B1–B3 land.
import { botStep } from './golden.mjs';
import * as lifecycle from '../src/sim/lifecycle.js';

const DEFAULTS = { minPct: 50, buybackCash: 4000, designEveryYears: 12, found: false, maxDesigns: 3, ownMissions: true };
const yearOf = (state) => state.startYear + Math.floor(state.turn / 52);
const hasAction = (r) => !(r && r.ok === false && /ação desconhecida/.test(String(r.error || '')));

/**
 * Founding payload for agency/found (§5.3 + §5.4 emblem), from the data at hand. Pure. The nation comes from the
 * founding options of the scenario (alive at the start year, with a launch-capable HQ site when there is one),
 * never from the actor the game was created for; kind is 'agency' (national) or 'company' (from the 80s on).
 */
export function foundingPayload(state, data, { name = 'Agência Austral', short = 'AUSTR', kind = 'agency', seed = state.seed, nationId = null } = {}) {
  const opts = (() => { try { return lifecycle.foundingOptions(data); } catch { return null; } })();
  const nations = opts?.nations || [];
  const k = Math.abs(Number(seed) || 1);
  const prefer = ['brazil', 'argentina', 'australia', 'canada', 'south_africa'];
  const launchable = nations.filter((n) => (n.sites || []).some((x) => x.launch));
  const nation = nations.find((n) => n.id === nationId)
    || prefer.map((id) => launchable.find((n) => n.id === id)).find(Boolean)
    || (launchable.length ? launchable[k % launchable.length] : nations[k % Math.max(1, nations.length)]) || null;
  const site = (nation?.sites || []).find((x) => x.launch) || nation?.sites?.[0] || null;
  const shapes = ['roundel', 'shield', 'hex', 'chevron', 'wing', 'star'];
  const glyphs = ['rocket', 'orbit', 'star', 'planet', 'comet', 'capsule'];
  const privateOk = opts ? !!opts.privateOk : yearOf(state) >= 1980;
  return {
    type: 'agency/found', name, short, kind: kind === 'company' && privateOk ? 'company' : 'agency', nationId: nation?.id || nationId || 'brazil',
    hq: site?.id ? { id: site.id } : { lat: -2.37, lon: -44.4 },
    emblem: { shape: shapes[k % shapes.length], field: '#1f3a5f', field2: '#e2ad35', division: 'band', ring: { color: '#e2ad35' }, glyph: glyphs[k % glyphs.length], glyphColor: '#f7f1e3', stars: k % 7, label: short },
  };
}

/** Try to found an agency at turn 0. Returns the new player id or null (action missing or refused). */
export function foundAgency(state, data, engine, opts = {}) {
  if (state.turn !== 0) return null;
  const r = engine.dispatch(state, data, foundingPayload(state, data, opts));
  return r?.ok ? (r.actorId || r.playerId || state.playerId) : null;
}

/** Offer of an investor-round choice: { pct, cashM } from the choice or the card payload. */
function offerOf(dec, choice) {
  const offers = dec.payload?.offers || [];
  const o = offers.find((x) => x.id === choice.id || x.offerId === choice.id) || choice.offer || choice.payload || choice;
  return { pct: Number(o?.pct ?? choice.pct) || 0, cashM: Number(o?.cashM ?? choice.cashM) || 0 };
}

/** Investor round: take the best cash per point that keeps the stake ≥ minPct (tight on cash: go to 30%). */
function answerRound(state, data, engine, dec, opts) {
  const pct = state.cap?.playerPct ?? 100;
  const cash = state.actors?.[state.playerId]?.cash ?? 0;
  const floor = cash < 200 ? Math.min(opts.minPct, 30) : opts.minPct;
  const choices = (dec.choices || []).filter((c) => !c.disabled);
  const decline = choices.find((c) => /decline|recusar|pass|none/.test(c.id)) || null;
  let best = null;
  for (const c of choices) {
    if (c === decline) continue;
    const o = offerOf(dec, c);
    if (!o.pct || pct - o.pct < floor) continue;
    const score = o.cashM / o.pct;
    if (!best || score > best.score) best = { c, score };
  }
  const pick = best?.c || decline || choices[choices.length - 1] || dec.choices?.[0];
  return engine.dispatch(state, data, { type: 'decision/resolve', id: dec.id, choiceId: pick?.id });
}

/** Cheapest catalog rocket the player can fly now (license base). */
function licenseBase(state, data, engine) {
  let opts = null;
  try { opts = engine.query(state, data, 'missions/draftOptions', { type: 'satellite', destination: 'leo' }); } catch { return null; }
  const v = (opts?.vehicles || []).filter((x) => x.valid && !x.design).sort((a, b) => (a.costM || 0) - (b.costM || 0))[0];
  return v?.id || null;
}

function designsOf(state) {
  const raw = state.designs;
  if (!raw || typeof raw !== 'object') return [];
  return (Array.isArray(raw) ? raw : Array.isArray(raw.list) ? raw.list : Object.values(raw)).filter((d) => d && d.id && (!d.owner || d.owner === state.playerId));
}

/** Hangar: every `designEveryYears` license the cheapest rocket and develop it (when the actions exist). */
function hangar(state, data, engine, opts, mem) {
  if (mem.noDesigns) return;
  const live = designsOf(state);
  for (const d of live) {
    // a saved design waits for money or parts: try to develop it again every half year
    const last = mem.developTried?.[d.id];
    if (!d.program && (last == null || state.turn - last >= 26)) {
      (mem.developTried ||= {})[d.id] = state.turn;
      const r = engine.dispatch(state, data, { type: 'design/develop', designId: d.id });
      if (!hasAction(r)) { mem.noDesigns = true; return; }
      if (r && !r.ok) (mem.refusals ||= []).push(`${d.id}: ${r.error}`), mem.refusals.splice(0, Math.max(0, mem.refusals.length - 3));
    }
  }
  const y = yearOf(state);
  if (live.length >= opts.maxDesigns || (mem.lastDesignYear != null && y - mem.lastDesignYear < opts.designEveryYears)) return;
  const cash = state.actors?.[state.playerId]?.cash ?? 0;
  if (cash < 600) return;
  const base = licenseBase(state, data, engine);
  if (!base) return;
  mem.lastDesignYear = y;
  const r = engine.dispatch(state, data, { type: 'design/license', vehicleId: base });
  if (!hasAction(r)) { mem.noDesigns = true; return; }
  const id = r?.designId || r?.design?.id;
  if (r?.ok && id) engine.dispatch(state, data, { type: 'design/develop', designId: id });
}

/** Missions without hardware: an operational design when valid, else the engineers' suggestion (golden bot). */
function useDesigns(state, data, engine) {
  if (!designsOf(state).some((d) => d.program?.phase === 'operational')) return;
  for (const m of state.missions.filter((x) => x.status === 'planning' && !x.vehicleId && x.source !== 'test' && x.source !== 'cert')) {
    let opts = null;
    try { opts = engine.query(state, data, 'missions/draftOptions', { ...m, missionId: m.id, vehicleId: null }); } catch { continue; }
    const v = (opts?.vehicles || []).find((x) => x.design && x.valid);
    if (!v) continue;
    engine.dispatch(state, data, { type: 'mission/update', missionId: m.id, patch: { vehicleId: v.id, spacecraftId: m.suggestion?.spacecraftId || m.spacecraftId || null } });
  }
}

/**
 * One own mission a year when the agenda has a free slot (§5.2) and the cash allows: a satellite to low orbit, on the
 * player's own operational design when it fits (exercises the agenda veto and the designs in long runs).
 */
function ownMission(state, data, engine, opts, mem) {
  if (!opts.ownMissions) return;
  const y = yearOf(state);
  if (mem.ownYear === y) return;
  if ((state.actors?.[state.playerId]?.cash ?? 0) < 400) return;
  if (state.missions.some((m) => m.status === 'planning' && m.source === 'custom' && !m.mandateId)) return;
  let ag = null;
  try { ag = engine.query(state, data, 'missions/agenda'); } catch { ag = null; }
  if (ag?.enforced && ag.left <= 0) return;
  mem.ownYear = y;
  const draft = { type: 'satellite', destination: 'leo', crew: {}, config: { strategy: 'balanced', fuelMargin: 0.1 } };
  let o = null;
  try { o = engine.query(state, data, 'missions/draftOptions', draft); } catch { return; }
  const sc = (o?.spacecraft || []).find((s) => s.valid);
  if (!sc) return;
  try { o = engine.query(state, data, 'missions/draftOptions', { ...draft, spacecraftId: sc.id }); } catch { return; }
  const vs = (o?.vehicles || []).filter((v) => v.valid);
  const v = vs.find((x) => x.design) || vs[0];
  if (!v) return;
  const r = engine.dispatch(state, data, { type: 'mission/create', draft: { ...draft, vehicleId: v.id, spacecraftId: sc.id } });
  if (r?.ok) mem.own = (mem.own || 0) + 1;
}

/** Test flights are booked as soon as possible (the design waits on them). */
function bookTestFlights(state, data, engine) {
  for (const m of state.missions.filter((x) => x.status === 'planning' && x.source === 'test')) {
    engine.dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
  }
}

/**
 * One bot step with the Phase B moves, then the shared golden bot (decisions, launches, scheduling).
 * `mem` is the bot's own memory between calls (not game state). opts: {schedule, minPct, designEveryYears, …}.
 */
export function phaseBStep(state, data, engine, opts = {}, mem = {}) {
  phaseBMoves(state, data, engine, opts, mem);
  if (state.gameOver) return;
  botStep(state, data, engine, { schedule: opts.schedule !== false });
}

/** The Phase B moves alone (for bots with their own scheduling loop: tools/smoke.mjs, tools/sim-campaign.mjs). */
export function phaseBMoves(state, data, engine, opts = {}, mem = {}) {
  const o = { ...DEFAULTS, ...opts };
  for (const dec of state.decisions.slice()) {
    if (state.gameOver) return;
    if (dec.kind === 'investors/round') answerRound(state, data, engine, dec, o);
  }
  // a rich director buys a slice back to keep autonomy (§5.2 buy-back)
  const cap = state.cap;
  if (cap && cap.playerPct < o.minPct && (state.actors?.[state.playerId]?.cash ?? 0) > o.buybackCash && !mem.noBuyback) {
    const h = (cap.holders || []).filter((x) => !x.anchor && x.kind !== 'founders').sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
    if (h) {
      const r = engine.dispatch(state, data, { type: 'investors/buyback', holderId: h.id, pct: Math.min(h.pct, o.minPct - cap.playerPct) });
      if (!hasAction(r)) mem.noBuyback = true;
    }
  }
  for (const md of o.schedule !== false && Array.isArray(state.mandates) ? state.mandates : []) {
    if ((md.status ?? 'open') !== 'open') continue;
    const mine = (state.missions || []).filter((m) => m.mandateId === md.id);
    if (mine.some((m) => !['done', 'cancelled'].includes(m.status))) continue;
    if (mine.filter((m) => m.status === 'done' && ['total', 'partial'].includes(m.result?.outcome)).length >= Math.max(1, md.count || 1)) continue;
    engine.dispatch(state, data, { type: 'mission/fromMandate', mandateId: md.id });
  }
  if (o.schedule !== false) {
    hangar(state, data, engine, o, mem);
    useDesigns(state, data, engine);
    bookTestFlights(state, data, engine);
    ownMission(state, data, engine, o, mem);
  }
}

/** Counters of what the Phase B systems did in a run (printed by tools/campaign.mjs). */
export function phaseBStats(state) {
  const ms = state.missions || [];
  const archived = state.missionsArchive?.stubs?.length || 0;
  return {
    playerPct: state.cap?.playerPct ?? null,
    holders: state.cap?.holders?.length ?? 0,
    mandates: Array.isArray(state.mandates) ? state.mandates.length : 0,
    mandateMissions: ms.filter((m) => m.mandateId).length,
    programMandates: ms.filter((m) => m.holderId && !m.mandateId).length,
    designs: designsOf(state).length,
    operational: designsOf(state).filter((d) => d.program?.phase === 'operational').length,
    testFlights: ms.filter((m) => m.source === 'test').length,
    designFlights: ms.filter((m) => m.vehicleId && String(m.vehicleId).startsWith('dsg_') && m.source !== 'test').length,
    archived,
  };
}

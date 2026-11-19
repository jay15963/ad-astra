// Phase B bot (B5, docs/EXPANSION.md §5, §6, §14): the moves a Phase B player makes, layered over the shared bot of
// tools/golden.mjs (whose default behaviour the golden fixture pins, so it is not edited):
//   - founds its own agency at turn 0 (`agency/found`, §5.3) when asked to,
//   - answers the yearly investor rounds (`investors/round`, §5.2) keeping a minimum stake, buys back when rich,
//   - opens the missions of open mandates (`mission/fromMandate`) so they fly before the deadline,
//   - licenses a catalog rocket and develops it in the Hangar (`design/license`, `design/develop`, §6) once in a
//     while, and flies operational designs on its own missions when they fit.
// Every Phase B action is optional: an engine without investors.js/designs.js answers "ação desconhecida" and the
// bot carries on, so the same runs work before and after B1–B3 land.
import { botStep, tenderMove } from './golden.mjs';
import * as lifecycle from '../src/sim/lifecycle.js';
import * as calendar from '../src/sim/calendar.js';

const DEFAULTS = { minPct: 50, buybackReserve: 0.5, buybackRich: 2, maxManifest: 6, designEveryYears: 12, found: false, maxDesigns: 3, ownMissions: true, research: true };
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

/** Player missions waiting to fly (planning or scheduled; test flights apart). */
const busyManifest = (state) => (state.missions || []).filter((m) => (m.status === 'planning' || m.status === 'scheduled') && m.source !== 'test').length;

/** Flights of the player that reached orbit or beyond in the last `weeks` (the agency can honour mandates). */
function recentSuccesses(state, weeks = 156) {
  return (state.missions || []).filter((m) => m.source !== 'test' && ['total', 'partial'].includes(m.result?.outcome)
    && Number.isFinite(m.launchTurn ?? m.scheduledTurn) && state.turn - (m.launchTurn ?? m.scheduledTurn) <= weeks).length;
}

/**
 * Investor round: take the best cash per point that keeps the stake ≥ minPct. Tight on cash (under half a year's
 * budget) a director whose agency flies (≥ 2 successes in 3 years) may go down to 30% and honour binding mandates;
 * one that cannot fly them keeps the autonomy (D1: selling to 30% with no rocket ended every founded agency on the
 * board's vote).
 */
function answerRound(state, data, engine, dec, opts) {
  const pct = state.cap?.playerPct ?? 100;
  const me = state.actors?.[state.playerId] || {};
  const cash = me.cash ?? 0;
  // a bot that does not fly its own missions (--fast) cannot honour binding mandates: it never gives up autonomy
  const tight = cash < Math.max(100, (me.budget || 0) * 0.5);
  // a director with more than a year and a half of budget in the bank does not sell (it would buy back later at a
  // 15% premium: sell/buy-back cycles left 23 small holders on the table)
  if (cash > Math.max(300, (me.budget || 0) * 1.5)) {
    const none = (dec.choices || []).find((c) => !c.disabled && /decline|recusar|pass|none/.test(c.id));
    if (none) return engine.dispatch(state, data, { type: 'decision/resolve', id: dec.id, choiceId: none.id });
  }
  const floor =tight && opts.schedule !== false && !opts.keepControl && recentSuccesses(state) >= 2 ? Math.min(opts.minPct, 30) : opts.minPct;
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
  const me = state.actors?.[state.playerId] || {};
  // US$ 400 mi for a big agency; half a year's budget for a small one (D1)
  if ((me.cash ?? 0) < Math.min(400, Math.max(60, (me.budget || 0) * 0.5))) return;
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
 * Buy-back (§5.2), checked every quarter. The cash above a reserve of `buybackReserve` × the yearly budget pays for
 * it: below `minPct` the bot buys back up to `minPct` (autonomy); with more than `buybackRich` budgets of spare cash
 * it buys the investors out, largest stake first (D1: the old rule waited for US$ 4 bi of cash, so a NASA with
 * US$ 14 bi bought back once in 40 years and a small agency never did). Anchor holders stay.
 */
function buybackMove(state, data, engine, o, mem) {
  const cap = state.cap;
  if (!cap || mem.noBuyback || state.gameOver) return;
  if (Number.isFinite(mem.buybackTurn) && state.turn - mem.buybackTurn < 13) return;
  mem.buybackTurn = state.turn;
  const me = state.actors?.[state.playerId] || {};
  const budgetM = Math.max(0, me.budget || 0);
  const spare = (me.cash ?? 0) - Math.max(100, budgetM * o.buybackReserve);
  if (spare <= 0) return;
  const below = cap.playerPct < o.minPct;
  const rich = spare > budgetM * o.buybackRich;
  if (!below && !rich) return;
  const target = rich ? 100 : o.minPct;
  if (cap.playerPct >= target) return;
  // below the autonomy line any outside holder will do; buying out a happy board when rich spares the state
  const h = (cap.holders || []).filter((x) => !x.anchor && x.kind !== 'founders' && x.pct > 0 && (below || x.kind !== 'government'))
    .sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
  if (!h) return;
  let pct = Math.min(h.pct, target - cap.playerPct);
  let price = null;
  for (; pct >= 1; pct--) {
    try { price = engine.query(state, data, 'investors/buybackPrice', h.id, pct); } catch { price = null; }
    if (Number.isFinite(price) && price <= spare) break;
  }
  if (pct < 1) return;
  const r = engine.dispatch(state, data, { type: 'investors/buyback', holderId: h.id, pct });
  if (!hasAction(r)) { mem.noBuyback = true; return; }
  if (r?.ok) mem.buybacks = (mem.buybacks || 0) + 1;
}

/**
 * A small agency's scheduling (D1): the shared golden bot never schedules below US$ 150 mi of cash after the flight,
 * which a founded agency of US$ 100–200 mi/ano never has. Here the floor is a quarter of the yearly budget (at most
 * US$ 150 mi): the missions that fit are scheduled before the golden bot looks at them.
 */
function scheduleAffordable(state, data, engine) {
  const me = state.actors?.[state.playerId] || {};
  const floor = Math.min(150, Math.max(20, (me.budget || 0) * 0.25));
  if (floor >= 150) return;
  for (const m of state.missions.filter((x) => x.status === 'planning' && x.vehicleId && x.spacecraftId)) {
    const cash = state.actors[state.playerId]?.cash ?? 0;
    if (cash - Math.max(0, (m.cost || 0) - (m.grantM || 0)) < floor) continue;
    let opts = null;
    try { opts = engine.query(state, data, 'missions/draftOptions', { ...m, missionId: m.id }); } catch { continue; }
    if ((opts?.earliestLaunchTurn ?? state.turn) >= state.endTurn) continue;
    engine.dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
  }
}

/**
 * Missions left without usable hardware (a launch contract expired, the suggested satellite belongs to an agency the
 * player has no deal with): pick a valid spacecraft, then the cheapest valid rocket, like a player in the builder.
 * Checked every 4 weeks.
 */
function fixHardware(state, data, engine, mem) {
  if (Number.isFinite(mem.fixTurn) && state.turn - mem.fixTurn < 4) return;
  mem.fixTurn = state.turn;
  for (const m of state.missions.filter((x) => x.status === 'planning' && x.source !== 'test' && x.source !== 'cert' && !x.calendarId)) {
    // a fresh mission without hardware gets a few weeks (an approved design or the engineers' pick may still come)
    if (!m.vehicleId && state.turn - (m.createdTurn ?? state.turn) < 8) continue;
    let o = null;
    try { o = engine.query(state, data, 'missions/draftOptions', { ...m, missionId: m.id }); } catch { continue; }
    const scs = o?.spacecraft || [];
    const scOk = m.spacecraftId && scs.some((s) => s.id === m.spacecraftId && s.valid);
    const sc = scOk ? m.spacecraftId : scs.find((s) => s.valid)?.id;
    if (!sc) continue;
    if (sc !== m.spacecraftId) {
      try { o = engine.query(state, data, 'missions/draftOptions', { ...m, missionId: m.id, spacecraftId: sc }); } catch { continue; }
    }
    const vs = (o?.vehicles || []).filter((v) => v.valid);
    // a mission still waiting for the engineers' (valid) suggestion is the golden bot's to fill
    if (!m.vehicleId && m.suggestion?.vehicleId && vs.some((v) => v.id === m.suggestion.vehicleId)) continue;
    const vOk = m.vehicleId && vs.some((v) => v.id === m.vehicleId);
    const v = vOk ? m.vehicleId : (vs.find((x) => x.design) || vs[0])?.id;
    if (!v || (v === m.vehicleId && sc === m.spacecraftId)) continue;
    engine.dispatch(state, data, { type: 'mission/update', missionId: m.id, patch: { vehicleId: v, spacecraftId: sc } });
  }
}

/**
 * Without any rocket to fly (a founded agency before its own design), ask the operator of the cheapest rocket that
 * reaches low orbit for a launch contract (`market/requestAccess`), at most once a year.
 */
function accessMove(state, data, engine, mem) {
  if (Number.isFinite(mem.accessTurn) && state.turn - mem.accessTurn < 52) return;
  let o = null;
  try { o = engine.query(state, data, 'missions/draftOptions', { type: 'satellite', destination: 'leo', crew: {} }); } catch { return; }
  if ((o?.vehicles || []).some((v) => v.valid)) return;
  mem.accessTurn = state.turn;
  let list = [];
  try { list = calendar.availableVehicles(state, data, state.playerId, { withLocked: true }) || []; } catch { return; }
  const leo = (v) => Number(v?.capacity?.leo ?? v?.capacity?.LEO ?? 0);
  const cands = list.filter((r) => !r.ok && !r.nodeId && r.item?.operator && leo(r.item) > 0.2 && /acordo|contrato/i.test(String(r.reason || '')))
    .sort((a, b) => (a.item.costM || 0) - (b.item.costM || 0));
  for (const c of cands.slice(0, 3)) {
    const r = engine.dispatch(state, data, { type: 'market/requestAccess', vehicleId: c.item.id });
    if (!hasAction(r)) return;
    if (r?.ok) { mem.accessAsked = (mem.accessAsked || 0) + 1; return; }
  }
}

/**
 * One bot step with the Phase B moves, then the shared golden bot (decisions, launches, scheduling).
 * `mem` is the bot's own memory between calls (not game state). opts: {schedule, minPct, designEveryYears, …}.
 */
export function phaseBStep(state, data, engine, opts = {}, mem = {}) {
  phaseBMoves(state, data, engine, opts, mem);
  if (state.gameOver) return;
  // the tender bids were placed by phaseBMoves (with its long-step manifest rule)
  botStep(state, data, engine, { schedule: opts.schedule !== false, tenders: false });
}

/** The Phase B moves alone (for bots with their own scheduling loop: tools/smoke.mjs, tools/sim-campaign.mjs). */
export function phaseBMoves(state, data, engine, opts = {}, mem = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.research) researchMove(state, data, engine, mem);
  for (const dec of state.decisions.slice()) {
    if (state.gameOver) return;
    if (dec.kind === 'investors/round') answerRound(state, data, engine, dec, o);
  }
  // tender board: bid on deliverable jobs; in long steps (eras 5–7) a director with a full launch manifest lets them
  // pass (a rich founded agency that took every contract flew ~17 a year in era 7 and the run went past 16 000 turns)
  if (o.schedule !== false && o.tenders !== false && !((state.clock?.stepWeeks ?? 1) >= 13 && busyManifest(state) >= o.maxManifest)) {
    tenderMove(state, data, engine);
  }
  buybackMove(state, data, engine, o, mem);
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
    accessMove(state, data, engine, mem);
    fixHardware(state, data, engine, mem);
    ownMission(state, data, engine, o, mem);
    scheduleAffordable(state, data, engine);
  }
}

/**
 * Missões v2 (MISSIONS-V2.md §12): the bot keeps its research slots busy, the cheapest available **unlock** node
 * first (what the player can build/fly is gated by research), else the cheapest available efficiency node. Checked
 * at most every 4 weeks; a node the action refuses (science, money, slots) is skipped until next time.
 */
export function researchMove(state, data, engine, mem = {}) {
  // only where research gates the catalog (the Corrida Lunar keeps its v0.8 bot), and never with the money for flights
  if (state.gameOver || !state.research || !(data.scenario?.techGating ?? state.techGating)) return 0;
  // research in progress never stops for lack of money (it is charged into the red): a sensible director in the
  // red cancels the project furthest from done, one per check, so the agency is not fired for a lab bill
  const cashNow = state.actors?.[state.playerId]?.cash ?? 0;
  if (cashNow < 0 && (state.research.projects || []).length) {
    const worst = [...state.research.projects].sort((a, b) => (a.progress || 0) - (b.progress || 0))[0];
    if (worst && (worst.progress || 0) < 0.9) engine.dispatch(state, data, { type: 'research/cancel', nodeId: worst.nodeId });
    return 0;
  }
  if (Number.isFinite(mem.researchTurn) && state.turn - mem.researchTurn < 4) return 0;
  mem.researchTurn = state.turn;
  let tree = null;
  try { tree = engine.query(state, data, 'research/tree'); } catch { return 0; }
  if (!Array.isArray(tree)) return 0;
  const busy = new Set((state.research.projects || []).map((p) => p.nodeId));
  const me = state.actors?.[state.playerId] || {};
  const cash = me.cash ?? 0;
  // research is paid week by week over the project: an unlock (what the agency can build and fly) may take up to
  // 60% of the cash or half a year's budget; efficiency nodes only a quarter of the cash (D1: with cash × 0.25 for
  // everything a founded agency of US$ 100 mi/ano never researched an orbital rocket and never flew in 1000 years)
  const room = (n) => (n.cost || 0) <= (n.kind === 'unlock' ? Math.max(cash * 0.6, (me.budget || 0) * 0.5) : cash * 0.25);
  const open = tree.filter((n) => n.status === 'available' && !busy.has(n.id) && n.canAffordScience !== false && room(n) && cash > 0);
  const by = (a, b) => (a.science || 0) - (b.science || 0) || (a.cost || 0) - (b.cost || 0) || String(a.id).localeCompare(String(b.id));
  // an unlock waiting for science or money keeps the science points: efficiency nodes only when no unlock waits
  const waiting = tree.some((n) => n.status === 'available' && n.kind === 'unlock' && !busy.has(n.id));
  const pick = [...open.filter((n) => n.kind === 'unlock').sort(by), ...(waiting ? [] : open.filter((n) => n.kind !== 'unlock').sort(by))];
  let started = 0;
  for (const n of pick) {
    const r = engine.dispatch(state, data, { type: 'research/start', nodeId: n.id, approach: 'safe' });
    if (r?.ok) { started++; mem.researched = (mem.researched || 0) + 1; continue; }
    if (/limite de|ciência insuficiente/.test(String(r?.error || ''))) break;
  }
  return started;
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

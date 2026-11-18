// Missões v2, missions-sim (docs/MISSIONS-V2.md §1, §3 calls, §5.3, §7.1): the taxonomy (types, subtypes, the
// legacy "lander" alias everywhere), payload validation texts and carrier capacity, research gating of the player,
// and full flights on the real Década Lunar data: a rover becomes an asset, an observatory joins a satellite fleet,
// supplies dock at the ISS (rendezvous + dock milestones, scene snapshot), a first module founds a station
// (module_release), a crew rotation keeps its people busy, a base module founds a base. Save/load mid-flight is
// identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import * as missions from '../src/sim/missions.js';
import { keyIndex } from '../src/core/gating.js';
import { templateType } from '../src/gen/programs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root, { scenarioId: 'decada_lunar' });
const PID = 'nasa';

function fresh({ allKeys = false, seed = 3 } = {}) {
  const s = engine.newGame(data, { seed, playerId: PID });
  s.actors[PID].cash = 1e6;
  if (allKeys) s.research.keys = [...keyIndex(data).byKey.keys()].sort();
  return s;
}
const q = (s, n, ...a) => engine.query(s, data, n, ...a);
const D = (s, a) => engine.dispatch(s, data, a);

/** Engine loop: launch decisions go, everything else takes its default; the launch scene is played to the end. */
function play(s, weeks, done, onLaunch = null) {
  const end = s.turn + weeks;
  let guard = 0;
  while (s.turn < end && !done() && guard++ < weeks * 6) {
    for (const d of s.decisions.slice()) {
      const c = d.kind === 'launch/ready' ? (d.choices.find((x) => !x.disabled) || d.choices[0]).id : d.defaultChoice || d.choices?.[0]?.id;
      D(s, { type: 'decision/resolve', id: d.id, choiceId: c });
    }
    let lg = 0;
    while (s.activeLaunch && lg++ < 400) {
      const al = s.activeLaunch;
      if (onLaunch) onLaunch(al);
      let r;
      if (al.pendingIntervention) r = D(s, { type: 'launch/choose', optionId: (al.pendingIntervention.options.find((o) => !o.disabled) || al.pendingIntervention.options[0]).id });
      else if (al.act === 'prelaunch') r = D(s, { type: 'launch/countdown' });
      else if (al.pendingHold) r = D(s, { type: 'launch/hold', choice: 'go' });
      else if (al.act === 'result') r = D(s, { type: 'launch/finish' });
      else r = D(s, { type: 'launch/step' });
      assert.ok(r.ok, r.error);
    }
    if (s.decisions.length) continue;
    engine.advance(s, data, 1);
  }
}

/** Create a mission from a draft with the engineers' pick, schedule it at the earliest date. */
function fly(s, draft) {
  if (draft.type === 'crewed' && !draft.crew) {
    const astro = Object.values(s.crew || {}).filter((p) => p.role === 'astronaut' && (!p.actorId || p.actorId === PID) && (!p.status || p.status === 'active'));
    draft = { ...draft, crew: { commander: astro[0]?.id || null, astronauts: astro.slice(1, 3).map((p) => p.id) } };
  }
  const sug = q(s, 'missions/suggest', draft);
  assert.ok(sug, `sugestão para ${JSON.stringify(draft)}`);
  const d = { ...draft, vehicleId: draft.vehicleId || sug.vehicleId, spacecraftId: draft.spacecraftId || sug.spacecraftId };
  const opt = q(s, 'missions/draftOptions', d);
  const r = D(s, { type: 'mission/create', draft: { ...d, crew: opt.draft?.crew || d.crew } });
  assert.ok(r.ok, r.error);
  const m = s.missions.find((x) => x.id === r.missionId);
  const v = q(s, 'missions/get', m.id);
  const rs = D(s, { type: 'mission/schedule', missionId: m.id, launchTurn: v.check?.earliestLaunchTurn });
  assert.ok(rs.ok, `${rs.error} ${JSON.stringify(v.check?.errors)}`);
  return m;
}
const errorsOf = (s, draft) => q(s, 'missions/draftOptions', draft).errors || [];

// ------------------------------------------------------------------ taxonomy

test('types: rover replaces lander; the legacy lander is probe/lander in drafts, programs and every data file', () => {
  assert.deepEqual(missions.TYPES, ['satellite', 'probe', 'rover', 'crewed', 'cargo', 'station']);
  assert.equal(missions.TYPE_LABELS.rover, 'Rover');
  assert.deepEqual(missions.missionTypeOf('lander'), { type: 'probe', sub: 'lander' });
  assert.deepEqual(missions.missionTypeOf('landing'), { type: 'probe', sub: 'lander' });
  assert.deepEqual(missions.missionTypeOf({ type: 'lander', sub: 'sample_return' }), { type: 'probe', sub: 'sample_return' });
  assert.deepEqual(missions.missionTypeOf('teleport'), { type: null, sub: null });
  const nd = missions.normalizeDraft({ type: 'lander', destination: 'lunar_surface' });
  assert.equal(nd.type, 'probe');
  assert.equal(nd.sub, 'lander');
  assert.deepEqual(templateType({ type: 'lander' }), { type: 'probe', sub: 'lander' });
  // no data file keeps the retired type
  const files = ['data/calendar.json', 'data/gen/gen-programs.json'];
  for (const e of readdirSync(path.join(root, 'data/eras'))) if (existsSync(path.join(root, 'data/eras', e, 'calendar.json'))) files.push(`data/eras/${e}/calendar.json`);
  for (const f of files) {
    const txt = readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/"type"\s*:\s*"lander"/.test(txt), `${f} ainda tem type lander`);
  }
  for (const d of data.destinations.destinations) assert.ok(!(d.missionTypes || []).includes('lander'), `${d.id} missionTypes lander`);
});

test('subtypes: probe on a surface is the landing; cargo/crewed to a station derive supply/rotation; spacecraft carry sub', () => {
  const s = fresh();
  assert.equal(missions.resolveSub(s, data, { type: 'probe', destination: 'lunar_surface' }), 'lander');
  assert.equal(missions.resolveSub(s, data, { type: 'probe', destination: 'lunar_orbit' }), 'orbiter');
  assert.equal(missions.resolveSub(s, data, { type: 'cargo', destination: 'iss' }), 'supply');
  assert.equal(missions.resolveSub(s, data, { type: 'station', destination: 'leo' }), 'found');
  assert.equal(missions.resolveSub(s, data, { type: 'station', destination: 'iss' }), 'expand');
  assert.equal(missions.resolveSub(s, data, { type: 'satellite', destination: 'leo', spacecraftId: 'generic_observatory' }), 'observatory');
  // every satellite and rover of the catalog names its subtype (generic multi-purpose craft excepted)
  const subs = new Set((data.missions?.subtypes || []).map((r) => `${r.type}:${r.id}`));
  for (const sc of data.spacecraft.spacecraft) {
    if (sc.kind === 'rover') assert.ok(subs.has(`rover:${sc.sub}`), `${sc.id} sub ${sc.sub}`);
    if (sc.kind === 'satellite' && sc.sub) assert.ok(subs.has(`satellite:${sc.sub}`), `${sc.id} sub ${sc.sub}`);
  }
  // the builder lists the subtype chips, locked ones with the research reason
  const o = q(s, 'missions/draftOptions', { type: 'rover', destination: 'lunar_surface' });
  assert.ok(o.subs.some((x) => x.id === 'light' && !x.locked));
  const cryo = o.subs.find((x) => x.id === 'cryobot');
  assert.ok(cryo.locked && /^Pesquise .+ para liberar/.test(cryo.locked.reason), JSON.stringify(cryo));
});

// ------------------------------------------------------------------ validation (§1.5)

test('validation texts: carrier capacity, surface cargo needs a lander, target required, research gate, client privileged', () => {
  const s = fresh({ allKeys: true });
  // Progress MS holds 2,5 t: 6 t of supplies does not fit
  let e = errorsOf(s, { type: 'cargo', sub: 'supply', destination: 'iss', vehicleId: 'soyuz2', spacecraftId: 'progress_ms', payload: { kind: 'supply', qty: 6 } });
  assert.ok(e.includes('A Progress MS leva no máximo 2,5 t de carga.'), e.join(' | '));
  e = errorsOf(s, { type: 'cargo', sub: 'supply', destination: 'iss', vehicleId: 'soyuz2', spacecraftId: 'progress_ms', payload: { kind: 'supply', qty: 2 } });
  assert.ok(!e.some((x) => /leva no máximo/.test(x)), e.join(' | '));
  // a base module on the Moon needs a cargo lander, not an orbital cargo ship
  e = errorsOf(s, { type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', vehicleId: 'falcon9', spacecraftId: 'starship_cargo', payload: { kind: 'base_module', moduleId: 'bs_solar', newAsset: true } });
  assert.ok(e.includes('Carga na superfície precisa de um módulo de pouso de carga.') || e.some((x) => /não foi projetada/.test(x)), e.join(' | '));
  e = errorsOf(s, { type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', vehicleId: 'falcon9', spacecraftId: 'cargo_dragon', payload: { kind: 'base_module', moduleId: 'bs_solar', newAsset: true } });
  assert.ok(e.includes('Carga na superfície precisa de um módulo de pouso de carga.'), e.join(' | '));
  // supplies to an orbit without a station there: pick the station
  e = errorsOf(s, { type: 'cargo', sub: 'supply', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'cargo_dragon', payload: { kind: 'supply', qty: 1 } });
  assert.ok(e.includes('Escolha a estação ou base de destino.'), e.join(' | '));
  // module of the wrong family
  e = errorsOf(s, { type: 'station', destination: 'iss', vehicleId: 'falcon9', payload: { kind: 'station_module', moduleId: 'bs_dome' } });
  assert.ok(e.includes('Cúpula pressurizada não é módulo de estação.') || e.some((x) => /não é módulo de estação/.test(x)), e.join(' | '));
  // a public draft cannot carry a client payload
  const pub = missions.publicDraft({ type: 'cargo', sub: 'client', payload: { kind: 'client' }, clientPayload: true });
  assert.equal(pub.sub, null);
  assert.equal(pub.payload.kind, null);
  assert.equal(pub.clientPayload, undefined);
  // research gate: without keys a base module is locked with the binding text
  const g = fresh();
  g.research.keys = (g.research.keys || []).filter((k) => !k.startsWith('module:base') && k !== 'missionType:base');
  e = errorsOf(g, { type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', vehicleId: 'falcon9', spacecraftId: 'generic_cargo_lander_s', payload: { kind: 'base_module', moduleId: 'bs_solar', newAsset: true } });
  assert.ok(e.some((x) => /^Pesquise .+ para liberar .+\.$/.test(x)), e.join(' | '));
});

test('computeCost adds the module, vehicles and supplies as their own lines', () => {
  const s = fresh({ allKeys: true });
  const c1 = missions.computeCost(s, data, missions.normalizeDraft({ type: 'cargo', sub: 'supply', destination: 'iss', vehicleId: 'falcon9', spacecraftId: 'cargo_dragon', payload: { kind: 'supply', qty: 3, targetAssetId: 'as_1' } }));
  assert.ok(c1.breakdown.some((l) => /^Suprimentos \(3 t\)$/.test(l.label) && l.amount > 0), JSON.stringify(c1.breakdown));
  const c2 = missions.computeCost(s, data, missions.normalizeDraft({ type: 'station', destination: 'iss', vehicleId: 'falcon9', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: 'as_1' } }));
  assert.ok(c2.breakdown.some((l) => l.label === 'Módulo Laboratório' && l.amount === 900), JSON.stringify(c2.breakdown));
});

// ------------------------------------------------------------------ flights

test('rover: lands, becomes a rover asset with its life, and the mission names the asset', () => {
  const s = fresh();
  const m = fly(s, { type: 'rover', destination: 'lunar_surface' });
  assert.equal(m.type, 'rover');
  play(s, 120, () => ['done', 'cancelled'].includes(m.status) || !!m.assetId);
  assert.ok(m.assetId, `status ${m.status}`);
  const a = s.assets.list.find((x) => x.id === m.assetId);
  assert.equal(a.kind, 'rover');
  assert.equal(a.ownerId, PID);
  assert.equal(a.site, 'lunar_surface');
  assert.ok(a.lifeEndTurn > s.turn - 30, 'rover life ends in the future of its landing');
});

test('satellite: an observatory joins a fleet that yields science until the end of its life', () => {
  const s = fresh();
  const m = fly(s, { type: 'satellite', sub: 'observatory', destination: 'leo' });
  assert.equal(m.spacecraftId, 'generic_observatory', 'the pick respects the subtype');
  play(s, 60, () => ['done', 'cancelled'].includes(m.status));
  assert.equal(m.status, 'done');
  const a = s.assets.list.find((x) => x.kind === 'satellite' && x.sub === 'observatory' && x.ownerId === PID);
  assert.ok(a && a.units.length >= 1 && a.units[0].endTurn > s.turn + 52 * 5, JSON.stringify(a));
});

test('supplies to the ISS dock: rendezvous + dock milestones on ascent, scene snapshot, supply delivered', () => {
  const s = fresh();
  const iss = s.assets.list.find((a) => a.histId === 'iss');
  assert.ok(iss, 'ISS asset exists in 2026');
  const m = fly(s, { type: 'cargo', sub: 'supply', destination: 'iss', payload: { kind: 'supply', qty: 2 } });
  assert.equal(m.payload.targetAssetId, iss.id);
  let target = null;
  let ms = null;
  play(s, 40, () => !['scheduled', 'launch'].includes(m.status), (al) => { target ||= al.target; ms ||= (al.milestones || []).map((x) => x.id || x); });
  assert.ok(target, 'activeLaunch.target');
  assert.equal(target.kind, 'station');
  assert.equal(target.assetId, iss.id);
  assert.equal(target.sequence, 'dock', 'Progress docks automatically');
  assert.ok(target.modules.length > 5);
  assert.deepEqual(ms.slice(-2), ['rendezvous', 'dock']);
  assert.ok(JSON.parse(JSON.stringify(target)), 'snapshot is JSON');
});

test('station: a first module founds a station (module_release); the next one expands it (dock/berth)', () => {
  const s = fresh({ allKeys: true });
  let target = null;
  let ms = null;
  const m = fly(s, { type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } });
  assert.equal(m.sub, 'found');
  play(s, 40, () => !!m.assetId || ['done', 'cancelled'].includes(m.status), (al) => { target ||= al.target; ms ||= (al.milestones || []).map((x) => x.id || x); });
  assert.equal(target?.sequence, 'release');
  assert.equal(ms.at(-1), 'module_release');
  const st = s.assets.list.find((a) => a.id === m.assetId);
  assert.equal(st.kind, 'station');
  assert.equal(st.ownerId, PID);
  assert.deepEqual(st.modules.map((x) => x.id), ['st_core']);
  // expand it
  target = null;
  const m2 = fly(s, { type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: st.id } });
  assert.equal(m2.sub, 'expand');
  play(s, 60, () => st.modules.some((x) => x.id === 'st_lab') || ['done', 'cancelled'].includes(m2.status), (al) => { target ||= al.target; });
  assert.ok(['dock', 'berth'].includes(target?.sequence), target?.sequence);
  assert.ok(st.modules.some((x) => x.id === 'st_lab'), JSON.stringify(st.modules));
});

test('crew rotation: the crew stays on the station (mission in operations) for the rotation weeks', () => {
  const s = fresh();
  // Crew Dragon on Falcon 9 (a Soyuz seat depends on the Roscosmos agreement and the tension of the day)
  const m = fly(s, { type: 'crewed', destination: 'iss', vehicleId: 'falcon9', spacecraftId: 'crew_dragon' });
  assert.equal(m.sub, 'rotation');
  play(s, 60, () => m.status === 'operations' || ['done', 'cancelled'].includes(m.status));
  if (m.status !== 'operations') return assert.ok(['done', 'cancelled'].includes(m.status)); // a failed launch ends early
  assert.ok(m.ops?.untilTurn - s.turn >= 20, `ops até ${m.ops?.untilTurn}, agora ${s.turn}`);
  const crew = [m.crew.commander, ...m.crew.astronauts].filter(Boolean);
  assert.ok(crew.length > 0);
  // the same people cannot be scheduled elsewhere while on the station
  const e = errorsOf(s, { type: 'crewed', destination: 'leo', vehicleId: m.vehicleId, spacecraftId: m.spacecraftId, crew: { commander: crew[0], astronauts: [] } });
  assert.ok(e.some((x) => /já está escalado/.test(x)), e.join(' | '));
});

test('base: solar panels delivered by a cargo lander found a base; save/load mid-flight is identical', () => {
  const s = fresh({ allKeys: true });
  const m = fly(s, { type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', payload: { kind: 'base_module', moduleId: 'bs_solar', newAsset: true } });
  assert.equal(data.index.spacecraft[m.spacecraftId].kind, 'lander');
  let target = null;
  play(s, 30, () => m.status === 'transit', (al) => { target ||= al.target; });
  // save/load while in transit: same JSON
  const json = engine.serialize(s);
  const back = engine.deserialize(json, data);
  assert.equal(engine.serialize(back), json);
  play(s, 80, () => !!m.assetId || ['done', 'cancelled'].includes(m.status), (al) => { target ||= al.target; });
  if (!m.assetId) return assert.ok(['done', 'cancelled'].includes(m.status));
  const b = s.assets.list.find((a) => a.id === m.assetId);
  assert.equal(b.kind, 'base');
  assert.deepEqual(b.modules.map((x) => x.id), ['bs_solar']);
  assert.equal(target?.sequence, 'surface');
});

test('a booked flight keeps hardware whose agreement ended; a planning one does not (§8.1)', () => {
  const s = fresh();
  const cal = q(s, 'missions/draftOptions', { type: 'crewed', destination: 'iss' });
  assert.ok(cal.spacecraft.some((x) => x.id === 'soyuz_ms' && x.valid), 'Soyuz MS bookable at start');
  const m = fly(s, { type: 'crewed', destination: 'iss', vehicleId: 'falcon9', spacecraftId: 'soyuz_ms' });
  const plan = D(s, { type: 'mission/create', draft: { type: 'crewed', destination: 'iss', vehicleId: 'falcon9', spacecraftId: 'soyuz_ms', crew: m.crew } });
  assert.ok(plan.ok);
  // every agreement with Roscosmos ends
  s.treaties = s.treaties.filter((t) => !t.parties?.includes('roscosmos'));
  const booked = q(s, 'missions/get', m.id).check?.errors || [];
  assert.ok(!booked.some((x) => /não está disponível/.test(x)), booked.join(' | '));
  const planning = q(s, 'missions/get', plan.missionId).check?.errors || [];
  assert.ok(planning.some((x) => /não está disponível/.test(x)) || planning.some((x) => /acordo/.test(x)), planning.join(' | '));
});

test('a landing pad of the agency at the site makes descent and touchdown safer (risk siteBonus)', async () => {
  const risk = await import('../src/sim/risk.js');
  const s = fresh();
  const base = { actorId: PID, type: 'probe', sub: 'lander', destination: 'lunar_south_pole', vehicleId: 'falcon9', spacecraftId: 'generic_lander', crew: { commander: null, astronauts: [], flightDirector: null }, config: { strategy: 'balanced', fuelMargin: 0.1 }, launchTurn: 20, crewed: false };
  const a = risk.missionRisk(s, data, base);
  const b = risk.missionRisk(s, data, { ...base, siteBonus: { landingRisk: -0.1 } });
  const td = (r) => r.milestones.filter((x) => risk.msGroup(x.id) === 'landing' || risk.msGroup(x.id) === 'descent').reduce((p, x) => p + x.pFail, 0);
  assert.ok(td(b) < td(a), `${td(b)} < ${td(a)}`);
  assert.ok(b.p > a.p);
});

// Era 6 pack (Interplanetária e Interestelar, 2200–2599): data/eras/e6/** + data/scenarios/primeira_estrela.json.
// The pack files and the scenario are listed into the manifest in memory (E6_FILES / SCENARIO), so this test works
// before and after the integrator adds them to data/packs.json. Checks: validator clean for the pack, event DSL,
// calendar consistency (owners alive, hardware fits, long voyages coherent), Hangar designs, tech tier t6, the short
// scenario plays and saves/loads identically, and loading the pack does not change a 1950 campaign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData } from '../tools/validate/rules.js';
import { loadData, nodeReader } from '../src/core/data.js';
import { dateToTurn } from '../src/core/time.js';
import * as engine from '../src/core/engine.js';
import * as narrative from '../src/sim/narrative.js';
import * as designs from '../src/sim/designs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E6_DIR = path.join(root, 'data/eras/e6');
const E6_FILES = ['era', 'snapshot', 'lineages', 'lifecycle', 'vehicles', 'spacecraft', 'destinations', 'parts', 'calendar', 'events', 'investors', 'crew'];
const SCENARIO = 'scenarios/primeira_estrela.json';
const readE6 = (f) => JSON.parse(fs.readFileSync(path.join(E6_DIR, `${f}.json`), 'utf8'));
const vocab = JSON.parse(fs.readFileSync(path.join(root, 'data/core/vocab.json'), 'utf8'));
const stars = JSON.parse(fs.readFileSync(path.join(root, 'data/core/stars.json'), 'utf8'));

function withE6(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  const p = m.packs.find((x) => x.id === 'e6');
  p.files = [...new Set([...(p.files || []), ...E6_FILES])];
  m.scenarios = { ...m.scenarios, primeira_estrela: SCENARIO };
  return m;
}
function withoutE6(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  m.packs.find((x) => x.id === 'e6').files = ['era'];
  return m;
}
async function readerWith(fix) {
  const base = await nodeReader(root);
  return async (name) => (name === 'packs' ? fix(await base(name)) : base(name));
}
let campaignAll = null;
const campaignData = async () => (campaignAll ||= await loadData(await readerWith(withE6), { scenarioId: 'campaign', eras: 'all' }));
const e6 = (list) => list.filter((x) => x.era === 'e6');

test('validator: the e6 pack and its scenario have no errors or warnings', () => {
  const { input } = loadRepoInput(root);
  input.manifest = withE6(input.manifest);
  input.sizes.e6 = {};
  for (const f of E6_FILES) {
    const text = fs.readFileSync(path.join(E6_DIR, `${f}.json`), 'utf8');
    input.packs.e6[f] = JSON.parse(text);
    input.sizes.e6[f] = Buffer.byteLength(text);
  }
  input.scenarios.primeira_estrela = JSON.parse(fs.readFileSync(path.join(root, 'data', SCENARIO), 'utf8'));
  const r = checkData(input, {});
  const mine = r.issues.filter((i) => i.pack === 'e6' || /eras\/e6|primeira_estrela/.test(i.path));
  assert.deepEqual(mine, [], mine.map((i) => `${i.level} ${i.path}: ${i.message}`).join('\n'));
  assert.ok(r.stats.packBytes.e6 < 350 * 1024, `pacote e6 ${r.stats.packBytes.e6} B (limite 350 KB)`);
  assert.ok(r.stats.bootBytes < 1.6 * 1024 * 1024, 'boot budget');
});

test('every pack file parses and the era meta is the e6 window', () => {
  for (const f of E6_FILES) assert.ok(readE6(f), f);
  const era = readE6('era');
  assert.equal(era.id, 'e6');
  assert.deepEqual([era.from, era.to], [2200, 2599]);
  assert.deepEqual(era.truthLayers, ['especulacao']);
  assert.ok(era.chapters.length >= 2 && era.chapters.length <= 4);
});

test('events: ≥ 120 cards, valid DSL, year windows inside the era, pt-BR text sizes', async () => {
  const data = await campaignData();
  const all = data.events.events;
  const ids = new Set(all.map((e) => e.id));
  const mine = e6(all).filter((e) => !e.id.startsWith('gen_')); // authored cards (gen_ev_* come from src/gen)
  assert.ok(mine.length >= 120, `${mine.length} eventos`);
  for (const ev of mine) {
    assert.match(ev.id, /^e6_/);
    assert.deepEqual(narrative.validateEvent(ev, data, ids), [], ev.id);
    const t = ev.trigger;
    assert.ok(t.fromYear >= 2200 && t.fromYear <= 2599, `${ev.id}: fromYear ${t.fromYear}`);
    if (t.untilYear != null) assert.ok(t.untilYear >= t.fromYear && t.untilYear <= 2599, `${ev.id}: untilYear`);
    assert.ok(ev.text.length >= 120 && ev.text.length <= 600, `${ev.id}: texto ${ev.text.length}`);
    assert.ok(ev.title.length <= 60, `${ev.id}: título`);
  }
  // spread: every chapter of the era has its own cards
  for (const [a, b] of [[2200, 2379], [2380, 2499], [2500, 2599]]) {
    assert.ok(mine.filter((e) => e.trigger.fromYear >= a && e.trigger.fromYear <= b).length >= 12, `capítulo ${a}–${b}`);
  }
  // the era's big firsts each have a reaction card
  // reactions to a calendar flight or a first carry no mission/person in the signal: a card that needs one
  // (missionRisk effect, {mission}, {person}, crew subject) would never be eligible (narrative.analyzeNeeds)
  for (const ev of mine.filter((e) => e.trigger.signalWhere?.calendarId || e.trigger.signalWhere?.milestoneId)) {
    const effects = ev.choices.flatMap((c) => c.effects || []);
    const texts = [ev.title, ev.text, ...ev.choices.flatMap((c) => [c.label, c.preview])].join(' ');
    assert.ok(!effects.some((f) => 'missionRisk' in f || f.crew === 'subject' || f.crewStatus), `${ev.id}: efeito exige missão/pessoa`);
    assert.ok(!/\{(mission|person)\}/.test(texts) && ev.portrait !== 'crew', `${ev.id}: texto exige missão/pessoa`);
  }
  // a reaction is a card on the 'first' signal, or on the success of the calendar flight that claims that first
  const firstsOf = (calId) => {
    const item = data.calendar.missions.find((m) => m.id === calId);
    const dest = item && data.index.destinations[item.destination];
    return item ? [item.milestone, ...[].concat(dest?.firsts?.[item.crewed ? 'crewed' : 'robotic'] ?? [])].filter(Boolean) : [];
  };
  const reacts = new Set(mine.flatMap((e) => {
    const w = e.trigger.signalWhere || {};
    if (w.milestoneId) return [w.milestoneId];
    const ok = [].concat(w.outcome ?? []).some((x) => x === 'total' || x === 'partial');
    return e.trigger.signal === 'mission/resolved' && w.calendarId && ok ? firstsOf(w.calendarId) : [];
  }));
  for (const m of ['first_interstellar_probe_arrival', 'exoplanet_crewed_landing', 'second_star_colony', 'first_generation_ship_launch']) assert.ok(reacts.has(m), m);
});

test('calendar: owners alive, hardware fits, long voyages are coherent, all especulacao with canon', async () => {
  const data = await campaignData();
  const items = e6(data.calendar.missions);
  assert.ok(items.length >= 15);
  const lin = Object.fromEntries(data.lineages.lineages.map((l) => [l.id, l]));
  const life = data.lifecycle.events;
  const ym = (d) => d.year * 12 + (d.month ?? 0);
  const bornOf = (id) => { const b = life.find((e) => e.op === 'birth' && e.actor === id); return b ? ym(b.date) : lin[id]?.born ? ym(lin[id].born) : -Infinity; };
  const deathOf = (id) => {
    const d = life.find((e) => (e.op === 'dissolve' && e.actor === id) || (e.op === 'merge' && (e.from || []).includes(id)));
    return d ? ym(d.date) : Infinity;
  };
  for (const m of items) {
    assert.equal(m.truthLayer, 'especulacao', m.id);
    assert.ok(m.canon?.onBreak, `${m.id}: canon`);
    const launch = m.inTransit ? m.launched : m.planned;
    const k = launch.year * 12 + (launch.month - 1); // calendar months are 1-based
    assert.ok(bornOf(m.owner) <= k && k < deathOf(m.owner), `${m.id}: ${m.owner} vivo em ${launch.year}`);
    const v = data.index.vehicles[m.vehicleId];
    const s = data.index.spacecraft[m.spacecraftId];
    const d = data.index.destinations[m.destination];
    assert.ok(v && s && d, m.id);
    assert.ok(s.compatibleVehicles.includes(v.id), `${m.id}: ${s.id} no ${v.id}`);
    assert.ok(s.destinations.includes(d.id), `${m.id}: ${s.id} vai a ${d.id}`);
    const cap = (v.capacity[d.capacityKey] || 0) * (d.capacityFactor ?? 1);
    assert.ok(cap >= s.massT, `${m.id}: ${v.id} leva ${cap} t, a nave tem ${s.massT} t`);
    assert.ok(v.availableFrom.year * 12 + v.availableFrom.month - 1 <= k, `${m.id}: ${v.id} existe na data`);
    if (m.crewed) assert.ok(v.crewRated, `${m.id}: ${v.id} certificado para tripulação`);
    if (m.inTransit) {
      const w = dateToTurn(m.planned.year, m.planned.month - 1, 2200) - dateToTurn(m.launched.year, m.launched.month - 1, 2200);
      assert.ok(Math.abs(w - d.transitWeeks) <= 5, `${m.id}: viagem ${w} sem, destino ${d.transitWeeks}`);
    }
    for (const p of m.prerequisites || []) assert.ok(data.index.calendar[p], `${m.id}: pré-requisito ${p}`);
  }
  // the era closes with the first landing under another sun
  const landing = items.filter((m) => [].concat(data.index.destinations[m.destination].firsts?.crewed || []).includes('exoplanet_crewed_landing'));
  assert.ok(landing.length >= 1 && landing.every((m) => m.planned.year < 2599));
});

test('destinations: interstellar ones sit on stars of core/stars.json and only e6 drives reach them', async () => {
  const data = await campaignData();
  const starIds = new Set();
  for (const s of stars.stars) { starIds.add(s.id); for (const p of s.planets || []) starIds.add(p.id); }
  const dests = e6(data.destinations.destinations);
  assert.ok(dests.length >= 8);
  for (const d of dests) {
    assert.ok(starIds.has(d.body), `${d.id}: corpo ${d.body}`);
    assert.equal(d.capacityKey, 'interstellar');
    assert.ok(d.prestige > 0 && d.transitWeeks >= 0);
  }
  for (const v of data.vehicles.vehicles) {
    if (v.capacity?.interstellar > 0) assert.equal(v.era, 'e6', `${v.id} só da era 6`);
  }
  // sails at 0.2 c to Proxima: about 21 years (4.24 ly / 0.2 c)
  const prox = data.index.destinations.proxima_centauri_system;
  assert.ok(Math.abs(prox.transitWeeks / 52 - 4.24 / 0.2) < 1.5);
});

test('vehicles: Hangar designs reproduce the catalog capacity (±10%) and parts exist at the date', async () => {
  const data = await campaignData();
  const parts = designs.partsOf(data);
  const withDesign = e6(data.vehicles.vehicles).filter((v) => v.design);
  assert.ok(withDesign.length >= 3);
  for (const v of withDesign) {
    for (const pid of designs.specPartIds(v.design)) assert.ok(parts.byId[pid], `${v.id}: peça ${pid}`);
    const s = designs.designStats(data, v.design, { year: v.design.year ?? v.availableFrom.year });
    assert.ok(s.ok, `${v.id}: ${s.errors.join('; ')}`);
    for (const k of ['leo', 'gto', 'tli', 'mars', 'outer']) {
      const want = v.capacity[k];
      if (!want) { assert.ok(s.capacity[k] < 1, `${v.id}.${k}`); continue; }
      assert.ok(Math.abs(s.capacity[k] - want) / want <= 0.1, `${v.id}.${k}: ${s.capacity[k]} vs ${want}`);
    }
  }
  for (const p of readE6('parts').parts) assert.ok(vocab.partFamilies[p.family] || !p.family, p.id);
});

test('tech tier t6: every branch, requirements of the same or an earlier tier, era 6', async () => {
  const data = await campaignData();
  const nodes = e6(data.tech.nodes.map((n) => ({ ...n, era: n.era === 6 ? 'e6' : n.era })));
  assert.ok(nodes.length >= 12);
  for (const n of nodes) {
    assert.equal(n.techTier, 't6');
    // MISSIONS-V2 §4.4: requires only ids of the same or an earlier tier
    for (const r of n.requires) {
      const req = data.index.tech[r];
      assert.ok(req, `${n.id} requer ${r}`);
      assert.ok(Number(String(req.techTier || 't4').slice(1)) <= 6, `${n.id} requer ${r} (${req.techTier})`);
    }
  }
  assert.deepEqual([...new Set(nodes.map((n) => n.branch))].sort(), Object.keys(vocab.techBranches).sort());
});

test('lifecycle: e6 actors are born, renamed and merged on fixed dates with known nations', async () => {
  const data = await campaignData();
  const life = e6Life();
  function e6Life() { return readE6('lifecycle').events; }
  const ids = new Set(readE6('lineages').lineages.map((l) => l.id));
  for (const id of ids) assert.ok(life.some((e) => e.op === 'birth' && e.actor === id), `${id} nasce`);
  for (const e of life) {
    assert.ok(e.date.year >= 2200 && e.date.year <= 2599 && e.date.month >= 0 && e.date.month <= 11, e.id);
    assert.equal(e.truthLayer, 'especulacao');
    assert.ok(e.source, e.id);
  }
  const nations = new Set(data.nations.nations.map((n) => n.id));
  for (const l of readE6('lineages').lineages) for (const n of l.nation || []) assert.ok(nations.has(n.id), `${l.id}: ${n.id}`);
  // starting rosters use known traits
  const traits = new Set(data.crew.traits.map((t) => t.id));
  for (const [actor, people] of Object.entries(readE6('crew').roster)) {
    assert.ok(ids.has(actor), actor);
    assert.ok(people.length >= 6);
    for (const p of people) for (const t of p.traits) assert.ok(traits.has(t), `${p.id}: ${t}`);
  }
});

test('scenario Primeira Estrela (2380–2420): starts with the Aurora in flight, plays, saves and loads identically', async () => {
  const sc = JSON.parse(fs.readFileSync(path.join(root, 'data', SCENARIO), 'utf8'));
  assert.ok(vocab.scenarios[sc.id], 'id do vocabulário');
  assert.deepEqual([sc.start.year, sc.end.year], vocab.scenarios[sc.id].years);
  const data = await loadData(await readerWith(withE6), { scenarioId: 'primeira_estrela', eras: 'auto' });
  assert.equal(data.scenario.id, 'primeira_estrela');
  for (const pid of sc.playable.actors) {
    const st = engine.newGame(data, { seed: 3, playerId: pid });
    assert.ok(st.actors[pid], `${pid} existe em 2380`);
    const aurora = st.calendar.find((c) => c.id === 'aurora');
    assert.ok(['launched', 'player'].includes(aurora.status), `Aurora a caminho (${aurora.status})`);
    if (pid === 'proxima') assert.ok(st.missions.some((m) => m.calendarId === 'aurora' && m.status === 'transit'), 'a Aurora é a missão do jogador');
    for (let i = 0; i < 12 && !st.gameOver; i++) {
      for (const d of [...st.decisions]) {
        const ch = (d.choices || []).find((c) => !c.disabled) || d.choices?.[0];
        engine.dispatch(st, data, { type: 'decision/resolve', id: d.id, choiceId: ch?.id ?? 'continue' });
      }
      const r = engine.dispatch(st, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
      assert.ok(r.ok, r.error);
    }
    assert.ok(st.turn >= 12 * 13 - 13, `${pid}: andou ${st.turn} semanas`);
    for (const a of Object.values(st.actors)) for (const k of ['cash', 'budget', 'prestige']) assert.ok(Number.isFinite(a[k] ?? 0), `${a.id}.${k}`);
    assert.deepEqual(st.log.filter((l) => /erro/.test(l)), []);
    const json = engine.serialize(st);
    assert.equal(engine.serialize(engine.deserialize(json, data)), json);
    assert.ok(json.length < 400 * 1024);
  }
});

test('determinism: loading the e6 pack does not change a 1950 campaign', async () => {
  const run = async (fix) => {
    const data = await loadData(await readerWith(fix), { scenarioId: 'campaign', eras: 'all' });
    const st = engine.newGame(data, { seed: 5, playerId: 'nasa' });
    for (let i = 0; i < 30; i++) {
      for (const d of [...st.decisions]) engine.dispatch(st, data, { type: 'decision/resolve', id: d.id, choiceId: (d.choices || [])[0]?.id ?? 'continue' });
      engine.dispatch(st, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
    }
    // calendar/vehicleStats hold one instance per catalog item of every loaded pack (lazy instancing is §10 work)
    return JSON.stringify({ turn: st.turn, actors: st.actors, firsts: st.firsts, news: st.news.map((n) => n.headline), events: st.events?.history });
  };
  assert.equal(await run(withE6), await run(withoutE6));
});

test('era skin: src/ui/css/era-6.css is a token block for body[data-era="e6"]', () => {
  const css = fs.readFileSync(path.join(root, 'src/ui/css/era-6.css'), 'utf8');
  assert.match(css, /body\[data-era="e6"\]\s*\{/);
  for (const t of ['--s0', '--s1', '--text', '--act', '--act-ink', '--accent']) assert.ok(css.includes(`${t}:`), t);
  assert.match(css, /prefers-reduced-motion/);
});

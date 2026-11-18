// Era 7 pack (Galáctica, 2600–2999): data/eras/e7/** + data/scenarios/grande_silencio.json (owner C7, EXPANSION §14).
// The test assembles the pack with every e7 file even while data/packs.json still lists only era.json (the integrator
// adds the file list and the scenario entry), so it checks exactly what the game will load once they are listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData, errorsOf } from '../tools/validate/rules.js';
import { loadData, nodeReader } from '../src/core/data.js';
import { validateEvent } from '../src/sim/narrative.js';
import * as designs from '../src/sim/designs.js';
import * as engine from '../src/core/engine.js';
import { runCampaign } from '../tools/campaign.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E7_DIR = path.join(ROOT, 'data', 'eras', 'e7');
/** Every file of the e7 pack, in merge order (the manifest entry the integrator should write). */
export const E7_FILES = ['era', 'snapshot', 'lineages', 'lifecycle', 'parts', 'vehicles', 'spacecraft', 'destinations', 'calendar',
  'events', 'crew', 'investors'];
const SCENARIO_ID = 'grande_silencio';
const SCENARIO_FILE = `scenarios/${SCENARIO_ID}.json`;
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', rel), 'utf8'));
const e7 = Object.fromEntries(E7_FILES.map((f) => [f, readJson(`eras/e7/${f}.json`)]));

/** Manifest with the full e7 file list and the era scenario (what packs.json will say after integration). */
function withE7(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  const p = m.packs.find((x) => x.id === 'e7');
  p.files = [...new Set([...E7_FILES, ...(p.files || [])])];
  m.scenarios = { ...m.scenarios, [SCENARIO_ID]: SCENARIO_FILE };
  return m;
}

/** Validator input with the e7 pack complete. */
function validatorInput() {
  const { input } = loadRepoInput(ROOT);
  input.manifest = withE7(input.manifest);
  input.packs.e7 = { ...input.packs.e7, ...JSON.parse(JSON.stringify(e7)) };
  input.sizes.e7 = Object.fromEntries(E7_FILES.map((f) => [f, fs.statSync(path.join(E7_DIR, `${f}.json`)).size]));
  input.scenarios[SCENARIO_ID] = readJson(SCENARIO_FILE);
  return input;
}

/** Data loader reading the repo but with the e7-complete manifest. */
async function loadE7(opts, { e7Files = true } = {}) {
  const base = await nodeReader(ROOT);
  const reader = async (name) => (name === 'packs' && e7Files ? withE7(await base('packs')) : base(name));
  return loadData(reader, opts);
}

const mine = (i) => i.pack === 'e7' || /eras\/e7\/|grande_silencio/.test(i.path || '');

test('validator: the e7 pack and its scenario have no errors (and stay inside the pack budget)', () => {
  const r = checkData(validatorInput());
  const e = errorsOf(r).filter(mine);
  assert.deepEqual(e, [], e.map((i) => `${i.path}: ${i.message}`).join('\n'));
  assert.ok(r.stats.packBytes.e7 < 350 * 1024, `pacote e7 com ${r.stats.packBytes.e7} bytes`);
  const warns = r.issues.filter((i) => i.level === 'warn' && mine(i) && !/ainda não existe|reservado|provisório/.test(i.message));
  assert.deepEqual(warns, [], warns.map((i) => `${i.path}: ${i.message}`).join('\n'));
});

test('era.json: 2–4 chapters inside 2600–2999, the last one is the final decade', () => {
  const ch = e7.era.chapters;
  assert.ok(ch.length >= 2 && ch.length <= 4);
  assert.equal(ch[ch.length - 1].from.year, 2990);
  assert.equal(e7.era.truthLayers.join(), 'especulacao');
  for (const k of ['launched', 'success', 'failed', 'first', 'delayed']) assert.ok(e7.era.newsTone?.calendar?.[k], `newsTone.calendar.${k}`);
  assert.ok(e7.era.newsTone.lifecycle?.birth && e7.era.newsTone.ticker?.length >= 8, 'tom da era: ciclo de vida e letreiro');
});

test('events: ≥ 120 valid cards with year triggers inside the era, ≥ 12 in the final decade', async () => {
  const data = await loadE7({ scenarioId: 'campaign', eras: 'all' });
  const list = e7.events.events;
  const ids = new Set(list.map((x) => x.id));
  assert.equal(ids.size, list.length, 'ids únicos');
  assert.ok(list.length >= 120, `${list.length} eventos`);
  const errors = list.flatMap((ev) => validateEvent(ev, data, new Set(data.events.events.map((x) => x.id))));
  assert.deepEqual(errors, []);
  for (const ev of list) {
    const from = ev.trigger?.fromYear;
    assert.ok(Number.isInteger(from) && from >= 2600 && from <= 2999, `${ev.id}: fromYear ${from}`);
    if (ev.trigger.untilYear != null) assert.ok(ev.trigger.untilYear >= from && ev.trigger.untilYear <= 2999, `${ev.id}: untilYear`);
  }
  assert.ok(list.filter((ev) => ev.trigger.fromYear >= 2990).length >= 12, 'década final');
  // chain follow-ups are scheduled by some choice
  const scheduled = new Set(list.flatMap((ev) => ev.choices.flatMap((c) => (c.effects || []).filter((fx) => fx.schedule).map((fx) => fx.schedule))));
  for (const ev of list) if (ev.chain?.step > 1 || ev.trigger.scheduledOnly) assert.ok(scheduled.has(ev.id), `${ev.id}: passo nunca agendado`);
  // every schedule target is an e7 event (chains stay inside the pack)
  for (const s of scheduled) assert.ok(ids.has(s), `agenda ${s}`);
});

test('vehicles: every design reproduces its catalog capacity within ±10% with era parts', async () => {
  const data = await loadE7({ scenarioId: 'campaign', eras: 'all' });
  for (const v of e7.vehicles.vehicles) {
    assert.ok(v.design, `${v.id}: design`);
    const s = designs.designStats(data, v.design, { year: v.availableFrom.year });
    assert.ok(s.ok, `${v.id}: ${s.errors.join('; ')}`);
    const err = Math.abs(s.capacity.leo - v.capacity.leo) / v.capacity.leo;
    assert.ok(err <= 0.1, `${v.id}: LEO ${s.capacity.leo} vs ${v.capacity.leo}`);
    for (const pid of designs.specPartIds(v.design)) {
      const part = designs.partsOf(data).byId[pid];
      assert.ok(part && part.availableFrom.year <= v.availableFrom.year, `${v.id}: peça ${pid} existe na data`);
    }
  }
});

test('calendar: hardware fits, owners alive, craft flies there, only especulacao with canon on dependent items', async () => {
  const data = await loadE7({ scenarioId: 'campaign', eras: 'all' });
  const V = data.index.vehicles; const S = data.index.spacecraft; const D = data.index.destinations;
  const items = e7.calendar.missions;
  assert.ok(items.length >= 20);
  for (const m of items) {
    const v = V[m.vehicleId]; const sc = S[m.spacecraftId]; const d = D[m.destination];
    assert.ok(v && sc && d, `${m.id}: referências`);
    assert.equal(m.truthLayer, 'especulacao', m.id);
    assert.ok((sc.compatibleVehicles || []).includes(v.id), `${m.id}: ${sc.id} não voa em ${v.id}`);
    assert.ok((sc.destinations || []).includes(d.id), `${m.id}: ${sc.id} não vai a ${d.id}`);
    assert.ok((v.capacity[d.capacityKey] || 0) * (d.capacityFactor ?? 1) >= sc.massT, `${m.id}: capacidade`);
    const ym = (x) => x.year * 12 + (x.month ?? 1);
    assert.ok(ym(v.availableFrom) <= ym(m.planned) && ym(sc.availableFrom) <= ym(m.planned), `${m.id}: hardware antes da data`);
    if ((m.prerequisites || []).length) assert.ok(m.canon?.onBreak, `${m.id}: canon`);
    assert.equal(m.crewed, m.type === 'crewed', `${m.id}: crewed × type`);
  }
});

test('lifecycle: authored actors are born in the era and every reference respects it', async () => {
  const data = await loadE7({ scenarioId: 'campaign', eras: 'all' });
  const born = Object.fromEntries(e7.lifecycle.events.filter((e) => e.op === 'birth').map((e) => [e.actor, e.date.year]));
  for (const l of e7.lineages.lineages) {
    assert.ok(born[l.id] >= 2600 && born[l.id] <= 2999, `${l.id}: nasce na era`);
    assert.equal(l.born.year, born[l.id], `${l.id}: born = evento`);
    assert.ok(data.index.lineages[l.id], `${l.id}: mesclado`);
  }
  for (const e of e7.lifecycle.events) assert.ok(e.date.year >= 2600 && e.date.year <= 2999, e.id);
});

test('determinism: loading the e7 pack does not change the 1950s', async () => {
  // Modules list every catalog entry eagerly (calendar.ensureSlices instantiates all items, vehicleStats has a row per
  // vehicle, budget keeps a 0 saving per rival program; EXPANSION §10 asks calendar for a 10-year lazy horizon). Those
  // dormant e7 rows, and the pack hash in state.dataPacks, are the only allowed differences.
  const e7Ids = new Set([...e7.calendar.missions.map((m) => m.id), ...e7.vehicles.vehicles.map((v) => v.id)]);
  const dormant = [];
  const strip = (o) => {
    if (Array.isArray(o)) {
      // packed rows of the save ({$r: [[id, …]]}) or plain objects with an id
      const gone = (x) => (Array.isArray(x) ? e7Ids.has(x[0]) : !!x && typeof x === 'object' && e7Ids.has(x.id));
      for (const x of o) if (gone(x)) dormant.push(Array.isArray(x) ? { row: x, attempts: x[4] || x[5] || x[6] } : x);
      return o.filter((x) => !gone(x)).map(strip);
    }
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (e7Ids.has(k.replace(/#\d+$/, ''))) { dormant.push(v); continue; }
      out[k] = strip(v);
    }
    return out;
  };
  const hashOf = (data) => {
    const state = engine.newGame(data, { seed: 3, playerId: 'nasa' });
    for (let i = 0; i < 30 && !state.gameOver; i++) {
      for (const d of [...state.decisions]) {
        const c = d.choices?.find((x) => !x.disabled)?.id ?? d.choices?.[0]?.id ?? 'continue';
        engine.dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c });
      }
      engine.dispatch(state, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
    }
    const raw = JSON.parse(engine.serialize(state));
    delete raw.dataPacks;
    return JSON.stringify(strip(raw));
  };
  const withPack = await loadE7({ scenarioId: 'campaign', eras: 'all' });
  const without = await loadE7({ scenarioId: 'campaign', eras: 'all' }, { e7Files: false });
  assert.equal(hashOf(withPack), hashOf(without));
  for (const v of dormant) {
    const ok = v === 0 || (v && typeof v === 'object' && !v.attempts && !v.flights && !v.launchTurn);
    assert.ok(ok, `linha de e7 mexida antes de 2600: ${JSON.stringify(v).slice(0, 120)}`);
  }
});

test('scenario O Grande Silêncio (2950 → jan/3000) plays to an ending with no errors', async () => {
  const sc = readJson(SCENARIO_FILE);
  assert.equal(sc.id, SCENARIO_ID);
  const data = await loadE7({ scenarioId: SCENARIO_ID, eras: ['e6', 'e7'] });
  assert.equal(data.scenario.start.year, 2950);
  const t0 = Date.now();
  const r = runCampaign(data, { seed: 5, playerId: sc.playable.actors[0], fast: true });
  assert.deepEqual(r.errors.filter((e) => !/^aviso/.test(e)), []);
  assert.equal(r.state.gameOver?.reason, 'ending', JSON.stringify(r.state.gameOver));
  const kb = engine.serialize(r.state).length / 1024;
  assert.ok(kb < 400, `save ${kb.toFixed(0)} KB`);
  const turns = r.eras.reduce((a, e) => a + e.turns, 0);
  assert.ok(turns >= 150 && turns <= 300, `${turns} turnos`);
  assert.ok(Date.now() - t0 < 60000);
  // the snapshot names the world of 2950 (no 21st-century names on live actors)
  for (const a of Object.values(r.state.actors)) assert.ok(!/\((EUA|China|Índia|Japão|Europa)\)$/.test(a.name), `${a.id}: ${a.name}`);
});

test('era palette: src/ui/css/era-7.css only styles body[data-era="e7"] tokens', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/css/era-7.css'), 'utf8');
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
  assert.ok(selectors.length >= 1);
  for (const s of selectors) assert.match(s, /body\[data-era="e7"\]/, s);
  for (const k of ['--s0', '--text', '--act', '--accent']) assert.ok(css.includes(`${k}:`), k);
});

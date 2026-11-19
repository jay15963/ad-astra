// Founding wizard "Quando começar" (EXPANSION.md §5.3): a campaign founded in a later era (data.ensureStartYear) and
// the starting levels "Dinheiro inicial" / "Tecnologia inicial" of 'agency/found' (lifecycle founding.levels,
// gating.foundingGrant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode, nodeReader, ensureStartYear, scenarioStartingAt, firstsBefore, manifestOf } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import * as G from '../src/core/gating.js';
import { customIdFor, validateFound, foundPreview, foundingOptions, foundingLevels, foundingTech } from '../src/sim/lifecycle.js';
import { wizardModel, startEras } from '../src/ui/found-agency.js';
import { createStore } from '../src/ui/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reader = await nodeReader(root);
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
/** Campaign data moved to `year` like the wizard does (every era pack kept, as Node tools do). */
const at = async (year) => ensureStartYear(await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' }), reader, year, { eras: 'all' });
const d2000 = await at(2000);
const d2051 = await at(2051);

const PAY = { name: 'Agência Espacial do Cerrado', short: 'AEC', kind: 'agency', nationId: 'brazil', hq: { id: 'brazil_alcantara' } };
const found = (data, extra = {}, seed = 11) => {
  const pay = { ...PAY, ...extra };
  const s = engine.newGame(data, { seed, playerId: customIdFor(pay, seed) });
  const r = engine.dispatch(s, data, { type: 'agency/found', ...pay });
  return { s, r, id: s.playerId };
};
const closed = (data, ids) => {
  const set = new Set(ids);
  const byId = G.keyIndex(data).byId;
  return ids.every((id) => (byId.get(id)?.requires || []).every((q) => set.has(q)));
};

test('foundingGrant: share 1 = historicalGrant; smaller shares are requires-closed subsets that keep the 1950 base', () => {
  const base = G.historicalGrant(campaign, 1951);
  assert.ok(base.includes('t1_prop_sounding'), '1950: the sounding rockets');
  for (const y of [1951, 1977, 2001, 2052]) {
    const full = G.historicalGrant(campaign, y);
    assert.deepEqual(G.foundingGrant(campaign, y, 1), full);
    let prev = 0;
    for (const share of [0, 0.25, 0.6, 1]) {
      const g = G.foundingGrant(campaign, y, share);
      assert.ok(g.length >= prev, `monotonic at ${y}`);
      prev = g.length;
      assert.ok(base.every((id) => g.includes(id)), `base kept at ${y}/${share}`);
      assert.ok(g.every((id) => full.includes(id)), `only what history had at ${y}`);
      assert.ok(closed(campaign, g), `prerequisites at ${y}/${share}`);
      assert.deepEqual(g, [...g].sort());
      assert.ok(g.length >= Math.round(full.length * share), `reaches the share at ${y}/${share}`);
    }
  }
  // 1950: nothing older than the base, so every level is today's start
  for (const share of [0.25, 0.6, 1]) assert.deepEqual(G.foundingGrant(campaign, 1951, share), base);
});

test('ensureStartYear moves the campaign start: era snapshot, packs of that era only, feats history already saw', async () => {
  const d = await loadDataNode(root, { scenarioId: 'campaign' }); // eras 'auto', like the browser
  assert.equal(d.scenario.start.year, 1950);
  await ensureStartYear(d, reader, 2051);
  assert.equal(d.scenario.start.year, 2051);
  assert.equal(d.scenario.startYear, 2051);
  assert.equal(d.scenario.snapshot, 'e5');
  assert.equal(d.scenario.end.year, 3000);
  assert.equal(d.scenario.id, 'campaign');
  assert.ok(d.packsLoaded.e5 && !d.packsLoaded.e6, 'the start era is loaded, later ones are not');
  // no 1950 dated content: the e1 calendar is not merged (catalog files only for earlier eras)
  assert.ok(!(d.calendar?.missions || d.calendar?.calendar || []).some((m) => /sputnik|vostok/i.test(m.id || '')), 'no e1 calendar in 2051');
  assert.equal(d.scenario.historicalFirsts.crewed_lunar_landing.year, 1969);
  assert.ok(Object.values(d.scenario.historicalFirsts).every((f) => f.year < 2051));
  assert.equal(foundingOptions(d).year, 2051);
  assert.ok(foundingOptions(d).nations.some((n) => n.id === 'russia') && !foundingOptions(d).nations.some((n) => n.id === 'ussr'), 'nations of 2051');
  // back to the scenario's own start
  await ensureStartYear(d, reader, null);
  assert.equal(d.scenario.start.year, 1950);
  assert.equal(d.scenario.snapshot, 'e1');
  assert.equal(d.scenario.historicalFirsts, null);
  assert.ok(d.packsLoaded.e1 && !d.packsLoaded.e5);
  // pure helpers
  assert.equal(scenarioStartingAt(campaign.scenario, 1950), campaign.scenario);
  assert.equal(scenarioStartingAt(campaign.scenario, 2200, manifestOf(campaign)).snapshot, 'e6');
  assert.deepEqual(firstsBefore([{ historicalFirsts: { a: { year: 1990 }, b: { year: 2000 } } }, { historicalFirsts: { a: { year: 1980 } } }], 2000), { a: { year: 1980 } });
});

test('a game founded in e3 and e5 starts there with the snapshot world, and each tech level gives its share', () => {
  for (const [data, year, snap] of [[d2000, 2000, 'e3'], [d2051, 2051, 'e5']]) {
    const counts = {};
    for (const tech of ['pouca', 'media', 'muita']) {
      const { s, r, id } = found(data, { tech });
      assert.ok(r.ok, r.error);
      assert.equal(s.startYear, year);
      assert.equal(s.clock.eraId, snap);
      assert.ok(s.firstsHistory.first_satellite || s.firstsHistory.crewed_orbit || Object.keys(s.firstsHistory).length > 5, 'feats before the start are history');
      const u = s.research.unlocked;
      counts[tech] = u.length;
      assert.ok(u.includes('t1_prop_sounding'));
      assert.ok(closed(data, u), `${year}/${tech}: tree consistent`);
      assert.deepEqual(u, foundingTech(data, tech, year).ids);
      assert.deepEqual(s.research.keys, G.keysOfNodes(data, u));
      // a suborbital rocket can always be built in the Hangar
      const sounding = engine.query(s, data, 'designs/templates').find((t) => t.id === 'sounding');
      assert.ok(sounding?.ok, `${year}/${tech}: sounding template`);
      const pv = engine.query(s, data, 'designs/preview', { spec: sounding.spec });
      assert.ok(pv.ok && pv.derived.capacity.suborbital > 0, `${year}/${tech}: suborbital`);
      assert.ok(s.actors[id].custom);
    }
    assert.ok(counts.pouca < counts.media && counts.media < counts.muita, JSON.stringify(counts));
    assert.equal(counts.muita, G.historicalGrant(data, year + 1).length, 'Muita = everything history had');
  }
});

test('money levels scale budget and cash; 1950 founding with Pouca matches the start without levels', () => {
  const v = (data, extra) => validateFound(data, { ...PAY, ...extra }).value;
  for (const data of [campaign, d2051]) {
    const lo = foundPreview(data, v(data, { money: 'pouco' }));
    const mid = foundPreview(data, v(data, { money: 'medio' }));
    const hi = foundPreview(data, v(data, { money: 'muito' }));
    assert.ok(Math.abs(lo.budget - mid.budget / 2) <= 1 && Math.abs(hi.budget - mid.budget * 2) <= 1, `${lo.budget} ${mid.budget} ${hi.budget}`);
    assert.ok(lo.cash < mid.cash && mid.cash < hi.cash);
    assert.deepEqual(foundPreview(data, v(data, {})).budget, mid.budget, 'no level = Médio');
    const { s, id } = found(data, { money: 'muito' });
    assert.equal(s.actors[id].budget, hi.budget);
    assert.equal(s.actors[id].cash, hi.cash);
  }
  // 1950: Pouca + Médio is today's founding, state for state
  const today = found(campaign, {});
  const pouca = found(campaign, { tech: 'pouca', money: 'medio' });
  assert.deepEqual(pouca.s.research.unlocked, today.s.research.unlocked);
  assert.equal(pouca.s.actors[pouca.id].budget, today.s.actors[today.id].budget);
  assert.equal(pouca.s.actors[pouca.id].cash, today.s.actors[today.id].cash);
  // unknown levels are refused with a pt-BR message
  assert.match(validateFound(campaign, { ...PAY, money: 'infinito' }).error, /dinheiro/);
  assert.match(validateFound(campaign, { ...PAY, tech: 'toda' }).error, /tecnologia/);
});

test('difficulty follows the levels: little money and technology is harder than a lot', () => {
  for (const data of [campaign, d2000, d2051]) {
    const p = (money, tech) => foundPreview(data, validateFound(data, { ...PAY, money, tech }).value).difficulty;
    const easy = p('muito', 'muita'), mid = p('medio', 'media'), hard = p('pouco', 'pouca');
    assert.ok(easy.score < mid.score && mid.score < hard.score, `${data.scenario.startYear}: ${easy.score} ${mid.score} ${hard.score}`);
    assert.ok(hard.notes.some((n) => /Dinheiro inicial pouco/.test(n)));
  }
  const lateHard = foundPreview(d2051, validateFound(d2051, { ...PAY, money: 'pouco', tech: 'pouca' }).value);
  const lateEasy = foundPreview(d2051, validateFound(d2051, { ...PAY, money: 'muito', tech: 'muita' }).value);
  assert.notEqual(lateHard.difficulty.label, lateEasy.difficulty.label, 'the label moves in a later era too');
  assert.match(lateHard.difficulty.notes.join(' '), /das \d+ tecnologias que a história tinha em 2051/);
  assert.equal(lateHard.tech.id, 'pouca');
  assert.equal(lateHard.money.mult, 0.5);
});

test('determinism and save/load: same seed and choices, same game; a later start reloads and keeps playing', () => {
  const a = found(d2051, { money: 'pouco', tech: 'media' }, 21);
  const b = found(d2051, { money: 'pouco', tech: 'media' }, 21);
  assert.equal(engine.serialize(a.s), engine.serialize(b.s));
  assert.notEqual(engine.serialize(found(d2051, { money: 'pouco', tech: 'pouca' }, 21).s), engine.serialize(a.s));
  engine.advance(a.s, d2051, 12);
  const json = engine.serialize(a.s);
  const back = engine.deserialize(json, d2051);
  assert.equal(engine.serialize(back), json);
  engine.advance(back, d2051, 8);
  assert.ok(back.actors[a.id], 'the founded agency survives');
  assert.ok(!back.log.some((l) => /erro/i.test(l)), back.log.filter((l) => /erro/i.test(l)).join('\n'));
  // a page reload loads the campaign at 1950 first: the save still reads and plays on that data
  const again = engine.deserialize(json, campaign);
  assert.equal(again.startYear, 2051);
  engine.advance(again, campaign, 4);
  assert.ok(!again.log.some((l) => /erro/i.test(l)));
});

test('wizard model and store: the Início step, the eras offered and useStart around a founded game', async () => {
  const eras = startEras(campaign);
  assert.equal(eras.length, 7);
  assert.deepEqual(eras.map((e) => e.year), [1950, 1976, 2000, 2026, 2051, 2200, 2600]);
  assert.equal(eras[0].name, 'A Corrida');
  const corrida = await loadDataNode(root, { scenarioId: 'a_corrida' });
  assert.deepEqual(startEras(corrida), [], 'a short scenario keeps its own date');
  const m = wizardModel(d2051, { kind: 'agency', nationId: 'brazil', hq: { id: 'brazil_alcantara' }, name: 'Agência X', short: 'AGX', money: 'muito', tech: 'pouca' });
  assert.equal(m.steps.length, 5);
  assert.deepEqual(m.steps.map((s) => s.id), ['inicio', 'tipo', 'sede', 'nome', 'resumo']);
  assert.ok(m.valid.ok, m.valid.error);
  assert.equal(m.payload.money, 'muito');
  assert.equal(m.preview.tech.id, 'pouca');
  assert.equal(m.preview.year, 2051);
  const lv = foundingLevels(d2051, { kind: 'agency', nationId: 'brazil' });
  assert.deepEqual(lv.money.map((x) => x.id), ['pouco', 'medio', 'muito']);
  assert.ok(lv.tech[0].count < lv.tech[2].count && lv.tech[2].count === lv.tech[2].total);
  // store: move the start, found, save; reload the slot from a 1950 store (the start follows the save)
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  const store = createStore(await loadDataNode(root, { scenarioId: 'campaign' }), { storage, reader });
  assert.equal(await store.useStart(2000), true);
  assert.equal(store.data.scenario.snapshot, 'e3');
  const pay = { ...PAY, money: 'medio', tech: 'media' };
  store.newGame({ playerId: customIdFor(pay, 5), seed: 5, scenarioId: 'campaign' });
  assert.ok(store.dispatch({ type: 'agency/found', ...pay }).ok);
  assert.equal(store.state.startYear, 2000);
  store.save();
  assert.equal(await store.useStart(null), true);
  assert.equal(store.data.scenario.start.year, 1950);
  assert.equal(await store.loadSlot('auto'), true);
  assert.equal(store.state.startYear, 2000);
  assert.equal(store.data.scenario.start.year, 2000, 'loading the save moved the data back to its start');
});

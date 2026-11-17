// UI fixes (mobile review): launch date chips the sim accepts, deduped validation messages, readable emblems,
// GDD tiers, per-destination "Primeiro" on the map, MET clock, arrival card label, intervention timer setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('launchSlots: inside [earliest, close), one chip per month, none when nothing is legal', async () => {
  const { launchSlots } = await import('../src/ui/missions-tab.js');
  const slots = launchSlots({ earliest: 10, closeTurn: Infinity }, 2, 260, 2026);
  assert.ok(slots.length >= 3 && slots.length <= 4);
  assert.equal(slots[0].turn, 10);
  assert.match(slots[0].label, /^O quanto antes · /);
  const months = slots.map((s) => s.label.replace('O quanto antes · ', '').split(' (')[0]);
  assert.equal(new Set(months).size, months.length, 'no two chips read the same month');
  // a 9-week window: every chip inside it, the last week included
  const w = launchSlots({ earliest: 40, closeTurn: 49 }, 2, 260, 2026);
  assert.ok(w.length >= 2);
  for (const s of w) assert.ok(s.turn >= 40 && s.turn < 49, `turn ${s.turn} inside the window`);
  assert.deepEqual(launchSlots({ earliest: 300, closeTurn: Infinity }, 2, 260, 2026), []);
  assert.deepEqual(launchSlots({ earliest: 50, closeTurn: 50 }, 2, 260, 2026), []);
});

test('planned mission sheet: every offered date passes the sim timing rules (Mars window)', async () => {
  const data = await loadDataNode(root);
  const { createStore } = await import('../src/ui/store.js');
  const { launchTurnOptions } = await import('../src/ui/missions-tab.js');
  let checked = 0;
  for (const playerId of ['cnsa', 'isro']) {
    const store = createStore(data, { storage: memStorage() });
    store.newGame({ playerId, seed: 7 });
    let draft = { type: 'probe', destination: 'mars_orbit' };
    let q = store.query('missions/draftOptions', draft);
    const v = q.vehicles.find((x) => x.valid);
    if (!v) continue; // this actor cannot reach Mars yet
    draft = { ...draft, vehicleId: v.id };
    q = store.query('missions/draftOptions', draft);
    const sc = q.spacecraft.find((x) => x.valid);
    if (!sc) continue;
    draft = { ...draft, spacecraftId: sc.id };
    const r = store.dispatch({ type: 'mission/create', draft });
    assert.equal(r.ok, true, r.error);
    const m = store.state.missions.find((x) => x.id === r.missionId);
    const opts = launchTurnOptions(store, m, null);
    assert.ok(opts.length > 0, `${playerId}: some date is offered`);
    for (const o of opts) {
      const chk = store.query('missions/draftOptions', { ...m, missionId: m.id, launchTurn: o.turn });
      const timing = chk.errors.filter((e) => /janela|Preparação|fim do cenário/i.test(e));
      assert.deepEqual(timing, [], `${playerId} ${o.label}`);
    }
    const s = store.dispatch({ type: 'mission/schedule', missionId: m.id, launchTurn: opts[0].turn });
    if (!s.ok) assert.ok(!/janela|Preparação/i.test((s.errors || [s.error]).join(' ')), s.error);
    checked++;
  }
  assert.ok(checked > 0, 'at least one actor could plan a Mars mission');
});

test('dedupeMessages / scheduleErrorText: same rule worded twice shows once, every reason shown', async () => {
  const { dedupeMessages, scheduleErrorText } = await import('../src/ui/missions-tab.js');
  const out = dedupeMessages([
    'Carga de 26,5 t excede a capacidade de 15,8 t do Falcon 9 até Órbita baixa da Terra.',
    'Carga de 26,5 t excede a capacidade de 15,8 t com essa margem.',
    'Caixa insuficiente: custo US$ 1,1 bi, caixa US$ 900 mi.',
    'Caixa insuficiente para pagar a missão agora.',
    'Orion não voa no Falcon 9.',
    'Escolha o comandante.',
    'Escolha o veículo lançador.',
  ]);
  assert.equal(out.length, 5);
  assert.ok(out.includes('Escolha o comandante.') && out.includes('Escolha o veículo lançador.'));
  const txt = scheduleErrorText({ ok: false, error: 'a', errors: ['Preparação mínima de 2 meses: a partir de abr/2026.', 'Fora da janela para Órbita de Marte.'] });
  assert.match(txt, /Preparação/);
  assert.match(txt, /Fora da janela/);
  assert.equal(scheduleErrorText({ ok: false, error: 'Só isso.' }), 'Só isso.');
});

test('emblems: readable ink on light fills, word-aware labels', async () => {
  const { emblemSVG, emblemLabel, inkFor } = await import('../src/ui/portrait.js');
  assert.equal(inkFor('#E8E8E8'), '#14202e');
  assert.equal(inkFor('#0072B2'), '#f7f1e3');
  assert.equal(emblemLabel({ short: 'Blue Origin' }), 'BLUE');
  assert.equal(emblemLabel({ short: 'Roscosmos' }), 'ROSC');
  assert.equal(emblemLabel({ short: 'SpaceX' }), 'SPACEX');
  assert.equal(emblemLabel({ short: 'Roscosmos', emblem: 'RSC' }), 'RSC');
  const svg = emblemSVG({ short: 'SpaceX', color: '#E8E8E8' });
  assert.match(svg, /fill="#14202e"[^>]*>SPACEX</);
});

test('new game tiers follow the GDD (China potência, Índia média, companies)', async () => {
  const data = await loadDataNode(root);
  const { tierOf } = await import('../src/ui/newgame.js');
  const A = data.index.actors;
  assert.equal(tierOf(A.nasa)[0], 'Potência');
  assert.equal(tierOf(A.cnsa)[0], 'Potência');
  assert.equal(tierOf(A.esa)[0], 'Média');
  assert.equal(tierOf(A.isro)[0], 'Média');
  assert.equal(tierOf(A.spacex)[0], 'Empresa');
  assert.equal(tierOf({ tier: 'media', launchPolicy: 'domestic' })[0], 'Média', 'explicit tier wins');
});

test('map: a destination only credits its own firsts; a route stop counts as visited', async () => {
  const data = await loadDataNode(root);
  const { ownFirsts, computeFog } = await import('../src/ui/map.js');
  const pole = ownFirsts(data, 'lunar_south_pole');
  assert.ok(!pole.includes('lunar_surface_robotic'), 'the general Moon landing is not the pole first');
  assert.ok(ownFirsts(data, 'lunar_surface').includes('lunar_surface_robotic'));
  assert.ok(ownFirsts(data, 'iss').length > 0 && ownFirsts(data, 'leo').length > 0, 'ties stay on both');
  const st = { playerId: 'cnsa', turn: 30, missions: [{ id: 'm1', destination: 'lunar_surface', status: 'done', result: { outcome: 'total', resolvedTurn: 20 } }], calendar: [], firsts: {} };
  const fog = computeFog(st, data);
  assert.equal(fog.dests.lunar_surface, 'player');
  assert.equal(fog.dests.lunar_orbit, 'player');
  assert.equal(fog.dests.lunar_south_pole, undefined);
});

test('launch scene: HUD MET runs on the TLM scale; touchdown happens after the last milestone', async () => {
  const { buildProfile, metAt, telemetryAt, fmtClock } = await import('../src/ui/launch-scene.js');
  const p = buildProfile([{ id: 'ignition' }, { id: 'liftoff' }, { id: 'maxq' }, { id: 'staging' }, { id: 'fairing_or_les' }, { id: 'orbit' }], 'ascent');
  assert.equal(fmtClock(metAt(p, p.times[4])), '03:30'); // the radio says "TLM T+3:30 · alt 110 km"
  assert.equal(fmtClock(metAt(p, p.times[5])), '08:50');
  assert.equal(fmtClock(3900), '1:05:00');
  const arr = buildProfile([{ id: 'descent' }, { id: 'hazard' }, { id: 'touchdown' }], 'arrival', 'moon');
  assert.ok(telemetryAt(arr, arr.times[2]).alt > 0, 'still a few metres up while the last card is open');
  assert.equal(telemetryAt(arr, 999).alt, 0);
});

test('arrival decision card is labelled Chegada; intervention timer setting', async () => {
  const { kindLabel } = await import('../src/ui/decisions.js');
  assert.equal(kindLabel('launch/ready', { payload: { phase: 'arrival' } }), 'Chegada');
  assert.equal(kindLabel('launch/ready', { payload: { phase: 'ascent' } }), 'Dia de Lançamento');
  const { interventionSecondsOf } = await import('../src/ui/settings.js');
  const { DEFAULT_SETTINGS } = await import('../src/ui/store.js');
  assert.equal(interventionSecondsOf(DEFAULT_SETTINGS), 5);
  assert.equal(interventionSecondsOf({ interventionSeconds: 10 }), 10);
  assert.equal(interventionSecondsOf({ interventionSeconds: 0 }), 0);
  assert.equal(interventionSecondsOf({ interventionSeconds: 7 }), 5);
});

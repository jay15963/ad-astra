// Phase B shell screens (docs/EXPANSION.md §12, §14 B6): registry wiring of every Phase B screen (availability,
// badges, stub fallback while a parallel builder's file is missing) and the pure models of Calendário de lançamentos,
// Finanças, Identidade and Anais on real game states (Corrida Lunar and the 1950 campaign). DOM-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, advance, query } from '../src/core/engine.js';
import * as screens from '../src/ui/screens.js';
import { calendarModel, horizonWeeks, bucketLabel } from '../src/ui/lancamentos.js';
import { financeModel } from '../src/ui/financas.js';
import { identityModel, saveEmblem } from '../src/ui/identidade.js';
import { annalsModel, annalKeyLabel } from '../src/ui/anais.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const lunar = await loadDataNode(root);
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const qOf = (state, data) => (name, fb, ...a) => { try { const v = query(state, data, name, ...a); return v ?? fb; } catch { return fb; } };
const ids = (st, data) => screens.drawerSections(st, data).flatMap((s) => s.items.map((d) => d.id));

test('registry: the B6 screens load their own modules (no "em breve" stub)', async () => {
  for (const [id, model] of [['lancamentos', 'calendarModel'], ['financas', 'financeModel'], ['identidade', 'identityModel'], ['anais', 'annalsModel']]) {
    const d = screens.screenById(id);
    assert.equal(d.nav, 'drawer', id);
    assert.equal(d.soon, null, `${id} is delivered`);
    const m = await d.load();
    assert.equal(typeof m.render, 'function', `${id}.render`);
    assert.equal(typeof m[model], 'function', `${id}.${model}`);
  }
  // Phase B screens of the other builders: real module when present, the stub page otherwise — never a crash
  for (const id of ['conselho', 'hangar']) {
    const m = await screens.screenById(id).load();
    assert.equal(typeof (m?.render || m?.default), 'function', `${id} loads something renderable`);
  }
});

test('registry: Conselho needs a cap table, Hangar follows the builder unlock, badges', () => {
  const lunarState = newGame(lunar, { seed: 3, playerId: 'nasa' });
  assert.ok(!ids({ ...lunarState, cap: undefined }, lunar).includes('conselho'), 'no cap table → no Conselho');
  assert.ok(ids({ ...lunarState, cap: { playerPct: 60, holders: [] } }, lunar).includes('conselho'));
  assert.ok(ids(lunarState, lunar).includes('hangar'), 'Corrida Lunar (2026): the builder is open');

  const c = newGame(campaign, { seed: 3, playerId: campaign.scenario.playableActors[0] });
  assert.equal(screens.unlocked(c, campaign, 'builder'), true, '1950: the Hangar is open from the start');
  const hg = screens.drawerSections(c, campaign).flatMap((x) => x.items).find((d) => d.id === 'hangar');
  assert.ok(hg && !hg.lockedNow, 'Hangar listed and not locked in 1950');
  // a founded agency sees Conselho from its very first turn (before the investors module builds the cap table)
  const founded = { ...c, cap: null, playerId: 'custom_x', actors: { ...c.actors, custom_x: { id: 'custom_x', custom: true } } };
  assert.ok(screens.boardPending(founded, campaign));
  assert.ok(ids(founded, campaign).includes('conselho'), 'founded agency → Conselho listed at turn 0');
  assert.ok(!screens.boardPending({ ...founded, playerId: c.playerId }, campaign), 'a historical agency waits for its cap table');
  assert.ok(!screens.boardPending(founded, { ...campaign, scenario: { ...campaign.scenario, unlocks: {} } }), 'no investors in the scenario → no board');
  assert.equal(screens.unlocked({ ...c, turn: 7 * 52 }, campaign, 'builder'), true);
  assert.equal(screens.unlocked(c, campaign, 'nada'), true, 'no unlock entry = open');
  // badges
  const st = { playerId: 'p', turn: 100, actors: { p: { cash: -5 } }, decisions: [{ kind: 'investors/round' }], missions: [],
    mandates: [{ id: 'a', status: 'open', deadlineTurn: 120 }, { id: 'b', status: 'open', deadlineTurn: 400 }, { id: 'c', status: 'done', deadlineTurn: 110 }],
    designs: [{ id: 'dsg_1', owner: 'p', program: { phase: 'testFlights' } }] };
  assert.equal(screens.badgeOf(screens.screenById('financas'), st), true, 'cash below zero');
  assert.equal(screens.badgeOf(screens.screenById('financas'), { ...st, actors: { p: { cash: 5 } } }), 0);
  assert.equal(screens.badgeOf(screens.screenById('lancamentos'), st), 1, 'one open mandate due within a year');
  assert.equal(screens.badgeOf(screens.screenById('conselho'), st), 1, 'investor offer waiting');
  assert.equal(screens.badgeOf(screens.screenById('conselho'), { ...st, decisions: [] }), true, 'deadline close → amber dot');
  assert.equal(screens.badgeOf(screens.screenById('hangar'), st), true, 'a design waits for its test flights');
  assert.equal(screens.mandatesDueSoon({}).length, 0);
});

test('Calendário: future launches only, by month, filters, investor deadlines, missions without a rocket', () => {
  const st = newGame(lunar, { seed: 7, playerId: 'nasa' });
  advance(st, lunar, 4);
  const before = JSON.stringify(st);
  const q = qOf(st, lunar);
  const m = calendarModel(st, lunar, q);
  assert.equal(JSON.stringify(st), before, 'the model does not touch the state');
  assert.equal(m.horizon, horizonWeeks(1));
  assert.ok(m.groups.length > 0, 'rivals have planned launches in 2026–2028');
  const flat = m.groups.flatMap((g) => g.items);
  for (const x of flat) {
    assert.ok(x.when >= st.turn && x.when <= st.turn + m.horizon, `${x.title} inside the horizon`);
    assert.ok(x.title && !/undefined|NaN/.test(`${x.title} ${x.sub}`), x.title);
  }
  for (let i = 1; i < flat.length; i++) assert.ok(flat[i].when >= flat[i - 1].when, 'sorted by date');
  for (const g of m.groups) for (const x of g.items) assert.equal(bucketLabel(x.when, st.startYear, 1), g.label);
  assert.equal(m.counts.all, m.counts.mine + m.counts.rivals);
  const rivals = calendarModel(st, lunar, q, { filter: 'rivais' }).groups.flatMap((g) => g.items);
  assert.ok(rivals.every((x) => x.kind === 'rival'));
  assert.ok(calendarModel(st, lunar, q, { filter: 'seus' }).groups.flatMap((g) => g.items).every((x) => x.kind !== 'rival'));
  // mandates (Phase B investors) show as deadlines of the holder
  const st2 = { ...st, cap: { playerPct: 60, holders: [{ id: 'gov', kind: 'government', name: 'Governo dos EUA', pct: 40 }] },
    mandates: [{ id: 'md1', holderId: 'gov', title: 'Satélite meteorológico', status: 'open', deadlineTurn: st.turn + 20 }] };
  const m2 = calendarModel(st2, lunar, q);
  const prazo = m2.groups.flatMap((g) => g.items).find((x) => x.kind === 'prazo');
  assert.ok(prazo && /Governo dos EUA/.test(prazo.sub) && prazo.chip === 'prazo');
  assert.equal(m2.counts.prazos, 1);
  // accepted missions without hardware wait in "A agendar" with the amber chip
  const st3 = { ...st, missions: [{ id: 'mx', name: 'Teste', status: 'planning', vehicleId: null, type: 'probe', destination: 'moon', source: 'calendar' }] };
  const m3 = calendarModel(st3, lunar, q);
  assert.equal(m3.toSchedule.length, 1);
  assert.equal(m3.toSchedule[0].chip, 'falta o veículo');
  // coarse eras group by quarter / year
  assert.equal(bucketLabel(52 * 137 + 30, 1950, 13), 'T3 2087');
  assert.equal(bucketLabel(52 * 791, 1950, 52), '2741');
  assert.ok(horizonWeeks(52) >= 52 * 8);
});

test('Finanças: KPIs, cash flow with the current year, areas, ledger, investor money', () => {
  const st = newGame(lunar, { seed: 11, playerId: 'nasa' });
  advance(st, lunar, 6);
  const before = JSON.stringify(st);
  const m = financeModel(st, lunar, qOf(st, lunar));
  assert.equal(JSON.stringify(st), before, 'pure');
  assert.equal(m.cash, st.actors.nasa.cash);
  assert.ok(m.flow.length >= 1 && m.flow[m.flow.length - 1].partial, 'current year last, partial');
  assert.ok(m.flowMax >= 1);
  assert.ok(m.ledger.length > 0 && m.ledger.every((e) => Number.isFinite(e.amount) && e.label));
  assert.ok(m.areas.every((a, i, arr) => i === 0 || arr[i - 1].value >= a.value), 'areas sorted');
  assert.equal(m.investors, null, 'no cap table → no investor block');
  assert.equal(m.trouble, false);
  // Phase B cap table + investor money in the ledger
  const yearTurn = st.turn;
  const st2 = JSON.parse(before);
  st2.cap = { playerPct: 45, valuationM: 800, holders: [{ id: 'f1', kind: 'fund', name: 'Fundo Órbita', pct: 30, mood: 55 }, { id: 'g', kind: 'government', name: 'Governo', pct: 25 }],
    history: [{ year: 2026, playerPct: 45, raisedM: 120 }] };
  st2.finance.ledger.push({ turn: yearTurn, amount: 120, category: 'investors', note: 'Aporte' }, { turn: yearTurn, amount: -8, category: 'dividends', note: 'Dividendos' });
  const m2 = financeModel(st2, lunar, qOf(st2, lunar));
  assert.equal(m2.investors.playerPct, 45);
  assert.equal(m2.investors.investorsPct, 55);
  assert.equal(m2.investors.autonomy, false, 'below 50% the mandates are binding');
  assert.deepEqual(m2.investors.holders.map((x) => x.id), ['f1', 'g'], 'largest stake first');
  assert.equal(m2.investors.raisedM, 120);
  assert.equal(m2.investors.inYear, 120);
  assert.equal(m2.investors.dividendsYear, -8);
  // trouble: negative cash
  const st3 = JSON.parse(before);
  st3.actors.nasa.cash = -50;
  assert.equal(financeModel(st3, lunar, qOf(st3, lunar)).trouble, true);
});

test('Identidade: lineage by date (NACA in 1950, NASA in 2026), colours, launch sites, emblem spec', () => {
  const st = newGame(lunar, { seed: 1, playerId: 'nasa' });
  const m = identityModel(st, lunar);
  assert.equal(m.short, 'NASA');
  assert.deepEqual(m.lineage.map((x) => x.short), ['NACA', 'NASA']);
  assert.equal(m.lineage.find((x) => x.current).short, 'NASA');
  assert.equal(m.futureNames, false);
  assert.ok(m.colors.some((c) => /^#/.test(c.hex)));
  assert.ok(m.launchSites.length > 0);
  assert.equal(m.bornText, 'mar/1915');
  const c = newGame(campaign, { seed: 1, playerId: 'nasa' });
  const mc = identityModel(c, campaign);
  assert.equal(mc.lineage.find((x) => x.current)?.short, 'NACA', '1950: still the NACA');
  assert.equal(mc.futureNames, true, 'the NASA name is still ahead');
  // a Phase B emblem spec (§5.4) is described and its colours listed
  const st2 = { ...st, actors: { ...st.actors, nasa: { ...st.actors.nasa, emblem: { shape: 'shield', field: '#112233', field2: '#ffcc00', division: 'half', glyph: 'rocket', glyphColor: '#ffffff', stars: 3 } } } };
  const m2 = identityModel(st2, lunar);
  assert.match(m2.specText, /Escudo · Meio a meio · Foguete · 3 estrelas/);
  assert.deepEqual(m2.colors.slice(0, 3).map((x) => x.hex), ['#112233', '#ffcc00', '#ffffff']);
  // HQ from the founding wizard (lat/lon)
  const st3 = { ...st, actors: { ...st.actors, nasa: { ...st.actors.nasa, hq: { name: 'Natal', lat: -5.8, lon: -35.2 } } } };
  assert.equal(identityModel(st3, lunar).hq.coords, '5,8° S · 35,2° O');
  // saving tries the reserved B1 actions in order and reports failure without throwing
  const seen = [];
  const fake = { dispatch: (a) => { seen.push(a.type); return { ok: a.type === 'agency/identity' }; } };
  assert.equal(saveEmblem(fake, { shape: 'hex' }).ok, true);
  assert.deepEqual(seen, ['agency/emblem', 'agency/identity']);
});

test('Anais: headlines by year/decade/century, agencies timeline, eras', () => {
  assert.equal(annalKeyLabel('1962'), '1962');
  assert.equal(annalKeyLabel('d1950'), 'Década de 1950');
  assert.equal(annalKeyLabel('c1900'), 'Século de 1900');
  const fake = { startYear: 1950, turn: 52 * 300, clock: { eraId: 'e5' }, actors: { a: { prestigeEra: 9 }, b: { prestigeEra: 3 } },
    annals: { c1900: [{ h: 'Velho', i: 3, t: 0 }], d2190: [{ h: 'Década', i: 2, t: 1 }], 2249: [{ h: 'Ano recente', i: 4, t: 9 }, { h: 'Outra', i: 1, t: 10 }] },
    eraHistory: [{ eraId: 'e1', turn: 52 * 20, standings: [{ id: 'a', prestigeEra: 50 }], firsts: [{ milestone: 'orbit', actorId: 'a', turn: 3 }], headline: 'Fim da corrida' }] };
  const m = annalsModel(fake, campaign);
  assert.deepEqual(m.years.map((y) => y.key), ['2249', 'd2190', 'c1900'], 'most recent first');
  assert.equal(m.years[0].lines[0].text, 'Ano recente');
  assert.equal(m.eras[0].id, 'e5');
  assert.equal(m.eras[0].current, true);
  assert.equal(m.eras[0].leader, 'a');
  assert.equal(m.eras[1].id, 'e1');
  assert.equal(m.eras[1].toYear, 1970);
  assert.equal(m.eras[1].firsts, 1);
  // a real campaign: the lifecycle timeline feeds the agencies view, nothing from the future
  const c = newGame(campaign, { seed: 2, playerId: 'nasa' });
  advance(c, campaign, 60);
  const mc = annalsModel(c, campaign, qOf(c, campaign));
  assert.ok(mc.agencies.every((e) => e.year <= mc.nowYear && e.text && !/undefined/.test(e.text)));
  assert.ok(mc.years.every((y) => y.lines.every((l) => typeof l.text === 'string' && !l.text.includes('[object'))));
  assert.ok(mc.eras.length >= 1 && mc.eras.every((e) => e.name));
});

test('styles: B6 screen classes exist, no sideways panning, balanced braces', () => {
  const css = read('styles.css');
  for (const c of ['.tela-cab', '.tela-acao', '.tela-sec', '.fluxo-ano', '.cota-barra', '.id-cartao', '.id-ficha', '.anais-mais', 'overflow-x: clip', '.gaveta-lista { overflow-x: hidden; }']) assert.ok(css.includes(c), c);
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
  for (const f of ['src/ui/lancamentos.js', 'src/ui/financas.js', 'src/ui/identidade.js', 'src/ui/anais.js', 'src/ui/screen-kit.js']) {
    const src = read(f);
    assert.ok(!/Math\.random|Date\.now/.test(src), `${f}: no nondeterminism in the UI models`);
    assert.ok(!/fetch\(|https?:\/\//.test(src), `${f}: no runtime downloads`);
  }
});

test('Finanças: on the first turn of a year the still-open finance year keeps its own label (no missing row)', () => {
  // the year is closed by budget.tick one step AFTER the turn lands on 52k: reproduce that window directly
  const st = newGame(lunar, { seed: 5, playerId: 'nasa' });
  advance(st, lunar, 3);
  const y0 = st.finance.year.year;
  st.finance.history = [{ year: y0 - 1, income: 100, spent: 90, net: 10, cash: 50 }];
  st.finance.year.income = 9225;
  st.turn = 52 * (y0 - st.startYear + 1); // first turn of y0+1, finance.year still y0
  const q = qOf(st, lunar);
  const m = financeModel(st, lunar, q);
  const fy = st.finance.year.year;
  const years = m.flow.map((x) => x.year);
  assert.equal(new Set(years).size, years.length, 'no duplicated years');
  assert.ok(years.includes(fy), 'the open finance year is a row');
  for (let i = 1; i < years.length; i++) assert.equal(years[i], years[i - 1] + 1, 'years are consecutive');
  const last = m.flow[m.flow.length - 1];
  assert.equal(last.year, fy);
  assert.equal(last.partial, fy >= m.year, 'only the current calendar year is marked "até agora"');
  assert.equal(m.year, y0 + 1);
  assert.deepEqual(years, [y0 - 1, y0], 'no row labelled with the new year, none missing');
  assert.equal(m.openPartial, false);
  assert.equal(last.income, 9225);
});

test('Calendário: planning missions are counted in the lead, never "nada no horizonte"', async () => {
  const st = newGame(lunar, { seed: 7, playerId: 'nasa' });
  st.missions = [{ id: 'mx', name: 'Teste', type: 'orbital', destination: 'leo', status: 'planning' }];
  st.calendar = [];
  const m = calendarModel(st, lunar, () => null);
  assert.equal(m.toSchedule.length, 1);
  const src = fs.readFileSync(path.join(root, 'src/ui/lancamentos.js'), 'utf8');
  assert.match(src, /a agendar/);
});

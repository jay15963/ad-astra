// The Eco mystery and the jan/3000 ending (EXPANSION.md §9, C9): data/core/eco.json, src/sim/eco.js, src/ui/ending.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { dateToTurn } from '../src/core/time.js';
import { rngFor } from '../src/core/rng.js';
import * as eco from '../src/sim/eco.js';
import { endingModel, choiceModel, annalsByCentury, labelOf } from '../src/ui/ending.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const ECO = readJson('data/core/eco.json');
const VOCAB = readJson('data/core/vocab.json');
const lunar = await loadDataNode(root);
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const BAD = /undefined|NaN|\[object Object\]|\{\w+\}/;

const turnOf = (y, m = 0) => dateToTurn(y, m, 1950);
const ctxAt = (s, label = 'eco', dt = 1) => ({ data: campaign, rng: (l = '') => rngFor(s.seed, s.turn, label, l), prevTurn: s.turn, dt, turn: s.turn, eraId: s.clock?.eraId });

/** A campaign state at a date with nothing pending (time is under test, not the player's cards). */
function at(year, { seed = 5, playerId = 'nasa' } = {}) {
  const s = engine.newGame(campaign, { seed, playerId });
  s.turn = turnOf(year);
  s.clock.eraId = campaign.eras.eras.find((e) => e.from.year <= year && e.to.year >= year)?.id ?? 'e7';
  s.decisions = [];
  s.activeLaunch = null;
  return s;
}
const strings = (o, out = []) => {
  if (typeof o === 'string') out.push(o);
  else if (o && typeof o === 'object') for (const v of Object.values(o)) strings(v, out);
  return out;
};

// ------------------------------------------------------------------ data

test('eco.json: one piece per vocabulary fragment, exactly one main per era, valid triggers and choices', () => {
  const frozen = Object.keys(VOCAB.ecoFragments).filter((k) => !k.startsWith('_'));
  const ids = ECO.pieces.map((p) => p.id);
  assert.deepEqual([...ids].sort(), [...frozen].sort(), 'pieces = vocab ecoFragments');
  for (const p of ECO.pieces) {
    const v = VOCAB.ecoFragments[p.id];
    assert.equal(p.era, v.era, `${p.id} era`);
    assert.equal(p.order, v.order, `${p.id} order`);
    assert.equal(!!p.main, !!v.main, `${p.id} main`);
    for (const m of p.trigger.milestones) assert.ok(VOCAB.milestones[m], `${p.id}: marco ${m}`);
    assert.ok(Number.isFinite(p.trigger.fallbackYear), `${p.id}: every piece has a fallback year`);
    const era = campaign.eras.eras.find((e) => e.id === p.era);
    assert.ok(p.trigger.minYear >= era.from.year && p.trigger.fallbackYear <= era.to.year && p.trigger.minYear <= p.trigger.fallbackYear, `${p.id}: years inside its era`);
    if (p.after) assert.ok(ids.includes(p.after), `${p.id}: after ${p.after}`);
    const ch = p.card.choices.map((c) => c.id);
    assert.equal(new Set(ch).size, ch.length);
    assert.ok(ch.includes(p.card.defaultChoice), `${p.id}: default choice`);
    assert.ok(ch.length >= 2 && ch.length <= 3);
    // each card offers every direction of the ending
    for (const k of eco.ENDING_IDS) assert.ok(p.card.choices.some((c) => c.lean?.[k] > 0), `${p.id}: a choice toward ${k}`);
    if (p.sources) for (const u of p.sources) assert.match(u, /^https:\/\//);
  }
  for (const era of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']) assert.equal(ECO.pieces.filter((p) => p.era === era && p.main).length, 1, era);
  for (const b of ECO.colegio.beats) {
    assert.ok(b.from <= b.to && b.from >= 2051 && b.to <= 2999, b.id);
    if (b.card) assert.ok(b.card.choices.some((c) => c.id === b.card.defaultChoice), b.id);
  }
  for (const d of ECO.drift) assert.ok(VOCAB.milestones[d.milestone], d.milestone);
  assert.deepEqual(Object.keys(ECO.endings), ['contato', 'silencio', 'heranca']);
  for (const [id, E] of Object.entries(ECO.endings)) {
    assert.equal(E.requirements.length, 3, id);
    for (const r of E.requirements) if (r.type === 'milestone') assert.ok(VOCAB.milestones[r.milestone], `${id}: ${r.milestone}`);
    for (const t of ['pleno', 'incerto', 'fragil']) { assert.ok(E.paras[t].length > 200, `${id}.${t}`); assert.ok(E.previews[t], `${id}.${t} preview`); }
    assert.ok(E.coherent && E.turn && E.close && E.world);
  }
  assert.equal(ECO.silence.lines.length, 10);
});

test('eco.json: pt-BR text without leftovers; only {person} in authored text; labels mirror the vocabulary', () => {
  const s = JSON.stringify(ECO);
  assert.doesNotMatch(s, /\bTODO\b|\bFIXME\b|[Ll]orem ipsum|\bundefined\b|\bNaN\b/);
  const { legacy, _doc, ...rest } = ECO;
  const marks = new Set([...JSON.stringify(rest).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  assert.deepEqual([...marks], ['person']);
  for (const [k, v] of Object.entries(ECO.milestoneLabels)) assert.equal(v, VOCAB.milestones[k]?.label, k);
  assert.ok(fs.statSync(path.join(root, 'data/core/eco.json')).size < 80 * 1024, 'eco.json < 80 KB (boot data)');
  const packs = readJson('data/packs.json');
  assert.ok(packs.packs.find((p) => p.id === 'core').files.includes('eco'), 'core pack lists eco');
});

// ------------------------------------------------------------------ activation

test('the Corrida Lunar never runs the Eco (no slice, no card, golden runs untouched)', () => {
  assert.equal(eco.isActive(lunar), false);
  const s = engine.newGame(lunar, { seed: 1, playerId: 'nasa' });
  assert.equal(s.eco, undefined);
  for (let i = 0; i < 30; i++) { s.decisions = []; s.activeLaunch = null; engine.tick(s, lunar); }
  assert.equal(s.eco, undefined);
  assert.ok(!s.decisions.some((d) => d.kind.startsWith('eco/')));
  assert.ok(eco.isActive(campaign));
  const c = engine.newGame(campaign, { seed: 1, playerId: 'nasa' });
  assert.deepEqual(c.eco.pieces, []);
  assert.deepEqual(c.eco.lean, { contato: 0, silencio: 0, heranca: 0 });
});

// ------------------------------------------------------------------ pieces

test('a milestone reached by the player opens the era piece as the agency\'s own card; its choice counts double', () => {
  const s = at(1960);
  s.firsts.lunar_far_side_image = { actorId: 'nasa', turn: s.turn };
  eco.tick(s, campaign, ctxAt(s));
  const rec = s.eco.pieces.find((p) => p.id === 'eco_e1_anomalia_radio');
  assert.equal(rec.via, 'player');
  const dec = s.decisions.find((d) => d.kind === 'eco/piece');
  assert.ok(dec && !dec.blocking && dec.expiresTurn > s.turn);
  assert.deepEqual(dec.choices.map((c) => c.id), ['publicar', 'classificar', 'arquivar']);
  assert.ok(s.news.some((n) => n.tags.includes('eco')));
  const rep = s.actors.nasa.reputation;
  const r = engine.dispatch(s, campaign, { type: 'decision/resolve', id: dec.id, choiceId: 'publicar' });
  assert.equal(r.ok, true);
  assert.equal(s.eco.lean.contato, 4);
  assert.equal(rec.choice, 'publicar');
  assert.ok(s.actors.nasa.reputation >= rep);
  // only one piece per tick, and the second piece waits for the first
  eco.tick(s, campaign, ctxAt(s));
  assert.equal(s.eco.pieces.length, 1, 'the second e1 piece needs its own trigger or 1972');
});

test('a rival milestone opens it as world news; the fallback year opens it anyway; expiry takes the default without effects', () => {
  const s = at(1960);
  s.firsts.lunar_far_side_image = { actorId: 'roscosmos', turn: s.turn };
  eco.tick(s, campaign, ctxAt(s));
  assert.equal(s.eco.pieces[0].via, 'world');
  const t = at(1964);
  eco.tick(t, campaign, ctxAt(t));
  assert.equal(t.eco.pieces[0]?.id, 'eco_e1_anomalia_radio', 'fallback 1964');
  const dec = t.decisions.find((d) => d.kind === 'eco/piece');
  const cash = t.actors.nasa.cash;
  t.turn = dec.expiresTurn;
  engine.tick(t, campaign);
  assert.ok(!t.decisions.includes(dec));
  assert.equal(t.eco.pieces[0].choice, 'arquivar');
  assert.equal(t.eco.pieces[0].auto, true);
  assert.equal(t.eco.lean.heranca, 2);
  assert.ok(Number.isFinite(t.actors.nasa.cash) && cash !== null);
});

test('a main piece never goes missing: eras skipped or ended without it are archived silently', () => {
  const s = at(2500);
  eco.tick(s, campaign, ctxAt(s));
  const archived = s.eco.pieces.filter((p) => p.via === 'arquivo').map((p) => p.eraId);
  assert.deepEqual(archived, ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.ok(!s.decisions.some((d) => d.payload?.pieceId && s.eco.pieces.find((p) => p.id === d.payload.pieceId)?.via === 'arquivo'));
  assert.ok(s.eco.colegio.born != null, 'the Colégio exists once e5 is behind');
  const t = at(1975);
  eco.onEraEnd(t, campaign, ctxAt(t), { from: 'e1', to: 'e2' });
  assert.ok(t.eco.pieces.some((p) => p.id === 'eco_e1_anomalia_radio' && p.via === 'arquivo'));
  assert.equal(t.eco.chron[0].era, 'e1');
  assert.equal(t.eco.chron[0].name, t.actors.nasa.name);
  // the lifecycle's scripted Colégio actor waits for 2 pieces (actor-gen needs.ecoPieces)
  assert.ok(Array.isArray(t.eco.pieces));
});

test('the Colégio Silêncio is born with the e5 piece, its beats move the relation and the lean, one per year', () => {
  const s = at(2091);
  eco.tick(s, campaign, ctxAt(s));
  const rec = s.eco.pieces.find((p) => p.id === 'eco_e5_colegio_silencio');
  assert.ok(rec);
  assert.ok(s.eco.colegio.born != null && s.eco.colegio.founder);
  const dec = s.decisions.find((d) => d.payload?.pieceId === rec.id);
  assert.match(dec.body, new RegExp(s.eco.colegio.founder));
  engine.dispatch(s, campaign, { type: 'decision/resolve', id: dec.id, choiceId: 'aliar' });
  assert.equal(s.eco.colegio.rel, 25);
  // walk the years of the Colégio beats: the beats fire (forced at the end of their windows), one per year
  let fired = 0;
  for (let y = 2092; y <= 2400; y++) {
    s.turn = turnOf(y);
    const before = Object.keys(s.eco.colegio.beats).length;
    eco.onYear(s, campaign, ctxAt(s));
    const after = Object.keys(s.eco.colegio.beats).length;
    assert.ok(after - before <= 1);
    fired += after - before;
    for (const d of s.decisions.filter((x) => x.kind === 'eco/colegio')) engine.dispatch(s, campaign, { type: 'decision/resolve', id: d.id, choiceId: d.defaultChoice });
  }
  assert.ok(fired >= 4, `beats fired: ${fired}`);
  assert.ok(s.eco.colegio.rel >= -100 && s.eco.colegio.rel <= 100);
});

test('drift: humanity\'s milestones lean the ending once each; the final decade grows quieter in the news', () => {
  const s = at(2700);
  s.firsts.stellar_archive = { actorId: 'nasa', turn: s.turn };
  s.firsts.interstellar_network = { actorId: 'gen_1', turn: s.turn };
  eco.onYear(s, campaign, ctxAt(s));
  eco.onYear(s, campaign, ctxAt(s));
  assert.equal(s.eco.lean.heranca, 6, 'stellar_archive by the player: 3 × 2');
  assert.equal(s.eco.lean.contato, 2);
  const t = at(2990);
  for (let y = 2990; y <= 2999; y++) { t.turn = turnOf(y); eco.onYear(t, campaign, ctxAt(t)); }
  assert.equal(t.news.filter((n) => n.tags.includes('silencio')).length, 10);
});

test('families: legacy chains of the player\'s people become the surnames of the epilogue', () => {
  const s = at(2400);
  s.crew = {
    a: { id: 'a', name: 'Rita Okafor', actorId: 'nasa', culture: 'us', hiredTurn: turnOf(1962), status: 'retired', role: 'engineer' },
    b: { id: 'b', name: 'João Okafor', actorId: 'nasa', culture: 'us', hiredTurn: turnOf(2001), status: 'retired', legacyOf: 'a', role: 'astronaut' },
    c: { id: 'c', name: 'Lia Okafor', actorId: 'nasa', culture: 'us', hiredTurn: turnOf(2380), status: 'active', legacyOf: 'b', role: 'flight_director' },
  };
  s.memorial = [{ crewId: 'a', name: 'Rita Okafor', turn: turnOf(1967) }];
  eco.onYear(s, campaign, ctxAt(s));
  const f = s.eco.families.Okafor;
  assert.deepEqual({ gen: f.gen, from: f.from, to: f.to, first: f.first, last: f.last, fallen: f.fallen }, { gen: 3, from: 1962, to: 2380, first: 'Rita Okafor', last: 'Lia Okafor', fallen: 1967 });
  const lines = eco.legacyLines(s, campaign);
  assert.ok(lines.some((l) => /Os Okafor serviram a agência por 3 gerações, de 1962 a 2380/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /Lia Okafor carregou o nome de Rita Okafor, que morreu a serviço em 1967/.test(l)));
  assert.ok(lines.some((l) => /Memorial: Rita Okafor, em 1967/.test(l)));
  for (const l of lines) assert.doesNotMatch(l, BAD);
});

// ------------------------------------------------------------------ the final event

function finalState(seed = 7) {
  const s = at(2999, { seed });
  s.turn = 54600 - 13;
  s.clock.eraId = 'e7';
  return s;
}

test('jan/3000: the eco card shows the three endings with requirements met/unmet and a lean-coloured preview', () => {
  const s = finalState();
  s.eco.lean = { contato: 3, silencio: 12, heranca: 5 };
  s.eco.colegio = { ...s.eco.colegio, born: turnOf(2090), rel: 40 };
  s.firsts.autonomous_colony = { actorId: 'gen_3', turn: turnOf(2150) };
  engine.tick(s, campaign);
  assert.equal(s.turn, 54600);
  const dec = s.decisions.find((d) => d.kind === 'ending/final');
  assert.ok(dec?.blocking && s.clock.endingPushed);
  assert.equal(s.decisions.filter((d) => d.kind === 'ending/final').length, 1, 'the engine does not push a second card');
  assert.deepEqual(dec.choices.map((c) => c.id), ['contato', 'silencio', 'heranca']);
  assert.ok(dec.choices.every((c) => !c.disabled), 'all three always available');
  const sil = dec.choices.find((c) => c.id === 'silencio');
  assert.deepEqual(sil.requirements.map((r) => r.met), [true, true, false]);
  assert.equal(sil.tone, 'incerto');
  assert.ok(sil.leaning && /inclinando/.test(sil.preview));
  assert.equal(dec.choices.find((c) => c.id === 'contato').tone, 'fragil');
  assert.match(dec.body, /inclina a calar/);
  const m = choiceModel(dec, s, campaign);
  assert.equal(m.dominant, 'silencio');
  assert.equal(m.options.length, 3);
  for (const x of strings(m)) assert.doesNotMatch(x, BAD);
});

test('choosing an ending ends the campaign with an epilogue whose tone follows the requirements; save/load keeps it', () => {
  const s = finalState(11);
  s.eco.lean = { contato: 2, silencio: 0, heranca: 9 };
  for (const m of ['stellar_archive', 'hundred_worlds']) s.firsts[m] = { actorId: 'nasa', turn: turnOf(2800) };
  s.eco.families = { Okafor: { surname: 'Okafor', gen: 4, from: 1962, to: 2900, first: 'Rita Okafor', last: 'Davi Okafor', fallen: null }, Lima: { surname: 'Lima', gen: 2, from: 2500, to: 2700, first: 'Ana Lima', last: 'Rui Lima', fallen: null } };
  engine.tick(s, campaign);
  const dec = s.decisions.find((d) => d.kind === 'ending/final');
  assert.equal(dec.choices.find((c) => c.id === 'heranca').tone, 'pleno');
  const r = engine.dispatch(s, campaign, { type: 'decision/resolve', id: dec.id, choiceId: 'heranca' });
  assert.equal(r.ok, true);
  assert.equal(s.gameOver.reason, 'ending');
  assert.equal(s.gameOver.ending, 'heranca');
  const ep = s.eco.epilogue;
  assert.equal(ep.ending, 'heranca');
  assert.equal(ep.tone, 'pleno');
  assert.equal(ep.coherent, true);
  assert.equal(ep.paras[0], ECO.endings.heranca.paras.pleno);
  assert.ok(ep.legacy.some((l) => /Os Okafor/.test(l)));
  for (const x of strings(ep)) assert.doesNotMatch(x, BAD);
  const back = engine.deserialize(engine.serialize(s), campaign);
  assert.deepEqual(back.eco, s.eco);
  // another lean, same choice: the epilogue says the agency turned
  const t = finalState(11);
  t.eco.lean = { contato: 20, silencio: 0, heranca: 1 };
  engine.tick(t, campaign);
  engine.dispatch(t, campaign, { type: 'decision/resolve', id: t.decisions.find((d) => d.kind === 'ending/final').id, choiceId: 'heranca' });
  assert.equal(t.eco.epilogue.coherent, false);
  assert.equal(t.eco.epilogue.tone, 'fragil');
  assert.ok(t.eco.epilogue.paras.includes(ECO.endings.heranca.turn));
});

test('a director gone before 3000 leaves the world\'s ending, computed from the lean, as a news epilogue', () => {
  const s = at(2300);
  s.eco.lean = { contato: 1, silencio: 8, heranca: 2 };
  s.gameOver = { reason: 'fired', turn: s.turn, summary: null };
  engine.endGame(s, campaign);
  assert.equal(s.eco.epilogue.ending, 'silencio');
  assert.equal(s.eco.epilogue.ai, true);
  assert.match(s.news[0].headline, /^Epílogo: Em janeiro de 3000, a humanidade escolheu o silêncio/);
  assert.ok(s.eco.epilogue.legacy[0].includes('2300'));
  // the world's text does not narrate the departed agency acting in 3000
  assert.equal(s.eco.epilogue.paras[0], ECO.endings.silencio.worldPara);
  for (const id of ['contato', 'silencio', 'heranca']) assert.ok(ECO.endings[id].worldPara?.length > 150, id);
});

test('Eco texts never pin the first tape to a year the trigger cannot guarantee; real-fact pieces open after the fact', () => {
  for (const p of ECO.pieces) {
    if (p.id !== 'eco_e1_anomalia_radio') assert.ok(!JSON.stringify(p).includes('1959'), p.id);
  }
  const byId = Object.fromEntries(ECO.pieces.map((p) => [p.id, p]));
  assert.ok(byId.eco_e2_telemetria_fantasma.trigger.minYear >= 1978, 'Wow! signal is Aug 1977');
  assert.ok(byId.eco_e3_rede_amadora.trigger.minYear >= 2020, 'SETI@home ran until 2020');
  const co = new Set(['contato', 'silencio', 'heranca'].map((id) => ECO.endings[id].coherent));
  assert.equal(co.size, 3, 'each ending has its own coherence line');
});

test('the same seed and choices give the same Eco, with save/load in between', () => {
  const run = (reload) => {
    let s = at(2088, { seed: 42 });
    for (let i = 0; i < 12; i++) {
      engine.tick(s, campaign);
      for (const d of s.decisions.slice()) engine.dispatch(s, campaign, { type: 'decision/resolve', id: d.id, choiceId: d.defaultChoice ?? d.choices?.[0]?.id });
      s.activeLaunch = null;
      if (reload) s = engine.deserialize(engine.serialize(s), campaign);
    }
    return s.eco;
  };
  const a = run(false);
  assert.deepEqual(a, run(true));
  assert.ok(a.pieces.some((p) => p.id === 'eco_e5_colegio_silencio'));
});

// ------------------------------------------------------------------ UI models

test('epilogue model: seven pages of the agency\'s 1,050 years, no undefined/NaN, Memorial wall capped', () => {
  const s = finalState(3);
  s.memorial = Array.from({ length: 55 }, (_, i) => ({ crewId: `x${i}`, name: `Pessoa ${i}`, turn: turnOf(1960 + i * 15) }));
  s.firsts.first_satellite = { actorId: 'nasa', turn: turnOf(1957) };
  s.firsts.crewed_lunar_landing = { actorId: 'nasa', turn: turnOf(1969) };
  engine.tick(s, campaign);
  engine.dispatch(s, campaign, { type: 'decision/resolve', id: s.decisions.find((d) => d.kind === 'ending/final').id, choiceId: 'contato' });
  const m = endingModel(s, campaign);
  assert.equal(m.endingId, 'contato');
  assert.deepEqual(m.cards.map((c) => c.id), ['final', 'agencia', 'primeiros', 'memorial', 'mundos', 'anais', 'fim']);
  assert.equal(m.cards[0].paras[0], ECO.endings.contato.paras[m.tone]);
  const mem = m.cards.find((c) => c.id === 'memorial');
  assert.equal(mem.names.length, 40);
  assert.equal(mem.more, 15);
  const pf = m.cards.find((c) => c.id === 'primeiros');
  assert.deepEqual(pf.rows.map((r) => r.title), ['Primeiro satélite artificial', 'Pouso tripulado na Lua']);
  const annals = { c1900: [{ h: 'Sputnik em órbita', i: 3, t: turnOf(1957) }], d2010: [{ h: 'Foguete pousa sozinho', i: 3, t: turnOf(2015) }], 2999: [{ h: 'O céu se cala', i: 3, t: turnOf(2999) }] };
  assert.deepEqual(annalsByCentury({ startYear: 1950, annals }).map((a) => [a.label, a.h]), [['1957', 'Sputnik em órbita'], ['2015', 'Foguete pousa sozinho'], ['2999', 'O céu se cala']]);
  assert.ok(m.cards.find((c) => c.id === 'anais').rows.length > 0);
  for (const x of strings(m)) assert.doesNotMatch(x, BAD);
  assert.equal(labelOf(campaign, 'first_eva'), VOCAB.milestones.first_eva.label);
});

test('ending.js UI: design-system scene, routed from decisions.js and app.js, stylesheet present', () => {
  const src = fs.readFileSync(path.join(root, 'src/ui/ending.js'), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/sim\//, 'UI reads the sim through engine queries');
  assert.match(src, /export function openEndingCard/);
  assert.match(src, /export function renderEnding/);
  const css = fs.readFileSync(path.join(root, 'src/ui/css/ending.css'), 'utf8');
  assert.match(css, /reduce-motion/);
  assert.doesNotMatch(css, /#ff6a3d/i, 'retired orange');
  assert.match(fs.readFileSync(path.join(root, 'src/ui/decisions.js'), 'utf8'), /import\('\.\/ending\.js'\)/);
  assert.match(fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8'), /import\('\.\/ending\.js'\)/);
});

// Founding an agency (docs/EXPANSION.md §5.3, Phase B builder B1): 'agency/found', 'agency/emblem', the wizard model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { customIdFor, foundingOptions, validateFound, foundPreview } from '../src/sim/lifecycle.js';
import { wizardModel, suggestName, defaultEmblem, fromMap } from '../src/ui/found-agency.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const lunar = await loadDataNode(root);

const PAY = {
  name: 'Agência Espacial do Cerrado', short: 'AEC', kind: 'agency', nationId: 'brazil', hq: { id: 'brazil_alcantara' },
  emblem: { shape: 'shield', field: '#0b6b3a', field2: '#f2c94c', division: 'band', glyph: 'rocket', glyphColor: '#ffffff', accent: '#f2c94c', stars: 5 },
};
const found = (data, pay = PAY, seed = 11) => {
  const id = customIdFor(pay, seed);
  const s = engine.newGame(data, { seed, playerId: id });
  const r = engine.dispatch(s, data, { type: 'agency/found', ...pay });
  return { s, r, id };
};

test('core data files for founding and emblems are loaded with the core pack', () => {
  assert.ok(Array.isArray(campaign.hqSites?.sites) && campaign.hqSites.sites.length >= 60);
  assert.ok(campaign.emblems?.specs?.nasa && campaign.emblemParts?.palettes?.length >= 16);
  const nations = new Set(campaign.nations.nations.map((n) => n.id));
  for (const s of campaign.hqSites.sites) {
    assert.ok(nations.has(s.nation), `sede ${s.id}: nação ${s.nation}`);
    assert.ok(Math.abs(s.lat) <= 85 && Math.abs(s.lon) <= 180, `sede ${s.id}: coordenadas`);
  }
  for (const n of campaign.nations.nations) assert.ok(campaign.hqSites.sites.some((s) => s.nation === n.id), `nação sem sede sugerida: ${n.id}`);
});

test('founding options follow the start date: nations alive, private companies allowed from the start', () => {
  const o = foundingOptions(campaign);
  assert.equal(o.year, 1950);
  assert.equal(o.offered, true);
  assert.equal(o.privateOk, true, 'o jogador pode fundar uma empresa privada desde 1950');
  const ids = o.nations.map((n) => n.id);
  assert.ok(ids.includes('ussr') && ids.includes('usa') && ids.includes('brazil'));
  assert.ok(!ids.includes('russia') && !ids.includes('uae') && !ids.includes('kazakhstan'), 'successor states do not exist in 1950');
  assert.ok(o.nations.find((n) => n.id === 'ussr').isos.includes('UKR'), 'the USSR covers Ukraine in 1950');
  assert.equal(foundingOptions(campaign, { ...campaign.scenario, start: { year: 1990, month: 0 } }).privateOk, true);
  assert.equal(foundingOptions(lunar).offered, false, 'Corrida Lunar does not offer founding');
  assert.equal(validateFound(campaign, { ...PAY, kind: 'company' }).ok, true, 'empresa privada em 1950');
});

test('validation messages (pt-BR) for bad payloads', () => {
  const bad = (p, re) => { const v = validateFound(campaign, { ...PAY, ...p }); assert.equal(v.ok, false); assert.match(v.error, re); };
  bad({ nationId: 'russia' }, /país/);
  bad({ name: 'X' }, /nome/i);
  bad({ short: 'A' }, /sigla/i);
  bad({ short: 'ABCDEFGH' }, /sigla/i);
  bad({ hq: { id: 'usa_houston' } }, /sede/i);
  bad({ emblem: { shape: 'blob', field: '#000000' } }, /logo/i);
  const v = validateFound(campaign, { ...PAY, name: '<b>Agência</b>', short: 'a-e<c' });
  assert.ok(v.ok);
  assert.ok(!/[<>]/.test(v.value.name + v.value.short));
  const map = validateFound(campaign, { ...PAY, hq: { lat: -15.5, lon: -47.6 } });
  assert.ok(map.ok && map.value.hq.lat === -15.5 && !map.value.hq.id, 'a point tapped on the map is a valid HQ');
});

test('agency/found creates a core custom actor that plays, saves and loads identically', () => {
  const { s, r, id } = found(campaign);
  assert.equal(r.ok, true, r.error);
  assert.equal(s.playerId, id);
  const a = s.actors[id];
  assert.ok(a && a.custom && a.tier === 'core' && a.lineage === id && a.nation === 'brazil');
  assert.equal(a.kind, 'agency');
  assert.deepEqual(a.capabilities.launchSites, ['Alcântara (Maranhão)']);
  assert.equal(a.hq.id, 'brazil_alcantara');
  assert.equal(a.emblem.shape, 'shield');
  assert.equal(a.emblem.label, 'AEC');
  assert.ok(JSON.stringify(a.emblem).length <= 200);
  const pv = foundPreview(campaign, validateFound(campaign, PAY).value);
  assert.equal(a.budget, pv.budget);
  assert.equal(a.cash, pv.cash);
  assert.ok(Object.values(s.crew).filter((c) => c.actorId === id).length >= 5, 'founding team');
  assert.ok(Object.keys(s.relations).some((k) => k.split('|').includes(id)), 'relations with the live core actors');
  assert.ok(s.news.some((n) => /Agência Espacial do Cerrado/.test(n.headline || '')));
  // determinism: same seed + same actions = same state; save/load identical; keeps playing
  assert.equal(engine.serialize(found(campaign).s), engine.serialize(s));
  engine.advance(s, campaign, 40);
  const back = engine.deserialize(engine.serialize(s), campaign);
  assert.equal(engine.serialize(back), engine.serialize(s));
  engine.advance(back, campaign, 10);
  assert.ok(back.actors[id], 'the founded agency survives');
  assert.ok(!back.log.some((l) => /erro/i.test(l)), back.log.filter((l) => /erro/i.test(l)).join('\n'));
  // only at the start
  const again = engine.dispatch(s, campaign, { type: 'agency/found', ...PAY, name: 'Outra Agência' });
  assert.equal(again.ok, false);
  assert.match(again.error, /início/);
});

test('agency/found re-keys a game created for another actor; AI lineage stays in the world', () => {
  const s = engine.newGame(campaign, { seed: 5, playerId: 'nasa' });
  const r = engine.dispatch(s, campaign, { type: 'agency/found', ...PAY, nationId: 'usa', hq: { id: 'usa_houston' } });
  assert.ok(r.ok, r.error);
  assert.notEqual(s.playerId, 'nasa');
  assert.ok(s.actors.nasa, 'NACA stays as an AI rival');
  assert.equal(Object.values(s.crew).filter((c) => c.actorId === 'nasa').length, 0, 'the founding team follows the new id');
  assert.deepEqual(s.actors[s.playerId].capabilities.launchSites, [], 'Houston has no launch site');
  // the old actor's real programs go back to the AI calendar: no inherited story missions
  assert.equal((s.calendar || []).filter((c) => c.status === 'player').length, 0, 'sem missões do calendário da NASA');
  // one founding per game: a second call is refused and leaves a single custom agency
  const again = engine.dispatch(s, campaign, { type: 'agency/found', ...PAY, name: 'Outra Agência', short: 'OUT' });
  assert.equal(again.ok, false);
  assert.equal(Object.keys(s.actors).filter((k) => k.startsWith('custom_')).length, 1);
});

test('agency/emblem changes the player logo with the same sanitizer', () => {
  const { s, id } = found(campaign);
  const ok = engine.dispatch(s, campaign, { type: 'agency/emblem', emblem: { shape: 'wordmark', field: '#0d1117', glyph: 'comet', ring: { color: '#0d1117', text: '<b>ad astra</b>' } } });
  assert.ok(ok.ok, ok.error);
  assert.equal(s.actors[id].emblem.shape, 'wordmark');
  assert.match(s.actors[id].emblem.ring.text, /AD ASTRA/);
  assert.ok(!/[<>]/.test(JSON.stringify(s.actors[id].emblem)));
  assert.equal(s.actors[id].emblem.label, 'AEC');
  assert.equal(engine.dispatch(s, campaign, { type: 'agency/emblem', emblem: { shape: 'hex', field: 'red' } }).ok, false);
});

test('difficulty is derived: a small company without a launch site is harder than a large-nation agency', () => {
  const opts = { ...campaign.scenario, start: { year: 1990, month: 0 } };
  const v1 = validateFound(campaign, { ...PAY, nationId: 'usa', hq: { id: 'usa_canaveral' } }, opts).value;
  const v2 = validateFound(campaign, { ...PAY, kind: 'company', nationId: 'chile', hq: { id: 'chile_santiago' } }, opts).value;
  const p1 = foundPreview(campaign, v1, opts);
  const p2 = foundPreview(campaign, v2, opts);
  assert.ok(p2.difficulty.score > p1.difficulty.score);
  assert.ok(p1.budget > p2.budget);
  assert.ok(p2.cash > p2.budget, 'a company starts with seed capital');
  for (const p of [p1, p2]) assert.ok(['Média', 'Difícil', 'Muito difícil'].includes(p.difficulty.label) && p.difficulty.notes.length >= 2);
});

test('wizard model: steps, suggestions, default emblem, map inverse projection', () => {
  const draft = { kind: 'agency' };
  let m = wizardModel(campaign, draft);
  assert.equal(m.steps[0].id, 'inicio');
  assert.equal(m.steps[1].done, true);
  assert.equal(m.steps[2].done, false);
  assert.equal(m.valid.ok, false);
  const nation = campaign.nations.nations.find((n) => n.id === 'brazil');
  const sug = suggestName(campaign, nation, 'agency', 0);
  assert.match(sug.name, /do Brasil$/);
  assert.ok(sug.short.length >= 2 && sug.short.length <= 6);
  const co = suggestName(campaign, nation, 'company', 7);
  assert.ok(co.name.split(' ').length >= 2 && co.short.length >= 2);
  const em = defaultEmblem(3, { kind: 'agency', short: sug.short });
  assert.equal(em.label, sug.short);
  assert.deepEqual(em, defaultEmblem(3, { kind: 'agency', short: sug.short }));
  Object.assign(draft, { nationId: 'brazil', hq: { id: 'brazil_brasilia' }, name: sug.name, short: sug.short, emblem: em });
  m = wizardModel(campaign, draft);
  assert.ok(m.valid.ok, m.valid.error);
  assert.ok(m.steps.every((s) => s.done));
  assert.ok(m.preview.budget > 0);
  // fromMap inverts the map projection used to place a tapped HQ
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  for (const [lat, lon] of [[-15.8, -47.9], [55.75, 37.6], [0, 0], [35.7, 139.7]]) {
    const K = 1000 / (2 * Math.PI * 0.8707);
    // project like the map does, then invert
    const l = (lon * Math.PI) / 180, p = (lat * Math.PI) / 180, p2 = p * p, p4 = p2 * p2;
    const x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
    const y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
    const p84 = (84 * Math.PI) / 180, q2 = p84 * p84, q4 = q2 * q2;
    const yTop = -(p84 * (1.007226 + q2 * (0.015085 + q4 * (-0.044475 + 0.028874 * q2 - 0.005916 * q4))));
    const g = fromMap((x + Math.PI * 0.8707) * K, (-y - yTop) * K);
    assert.ok(near(g.lat, lat, 0.05) && near(g.lon, lon, 0.05), `${lat},${lon} -> ${g.lat},${g.lon}`);
  }
});

test('Corrida Lunar golden path untouched: agency/found refused there', () => {
  const s = engine.newGame(lunar, { seed: 1, playerId: 'nasa' });
  const r = engine.dispatch(s, lunar, { type: 'agency/found', ...PAY });
  assert.equal(r.ok, false);
  assert.equal(s.playerId, 'nasa');
});

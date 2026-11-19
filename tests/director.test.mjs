// Fired is not game over (v0.9.13, src/sim/director.js): the world goes on, the old agency becomes an AI actor, the
// player takes another agency or founds one at today's date, the save is never reset, tenures are remembered.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { legacyLines } from '../src/sim/eco.js';
import { foundingTech } from '../src/sim/lifecycle.js';
import { directorMove } from '../tools/golden.mjs';

const { newGame, dispatch, query, tick, isBlocked, serialize, deserialize, endGame } = engine;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lunar = await loadDataNode(root);
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });

/** Plain steps without the player's cards or launch days (the world moves, the player does nothing). */
function steps(s, data, n) {
  for (let i = 0; i < n && !s.gameOver; i++) {
    s.decisions = s.decisions.filter((d) => d.kind === 'era/transition');
    for (const d of s.decisions.slice()) dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: 'continue' });
    s.activeLaunch = null;
    const r = dispatch(s, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
    if (!r.ok || !r.advanced) break;
  }
}

/** The real path: weeks in the red with no support, the government fires the director at the end of the step. */
function fire(s, data) {
  s.finance.debtWeeks = 400;
  s.actors[s.playerId].cash = -5000;
  s.actors[s.playerId].support = 0;
  s.decisions = s.decisions.filter((d) => d.kind === 'era/transition');
  s.activeLaunch = null;
  dispatch(s, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
}

test('fired in the Corrida Lunar: no game over, the clock waits, only the choice is allowed', () => {
  const s = newGame(lunar, { seed: 7, playerId: 'nasa' });
  steps(s, lunar, 20);
  fire(s, lunar);
  assert.equal(s.gameOver, null);
  assert.equal(s.director.ousted?.reason, 'fired');
  assert.equal(isBlocked(s, lunar), 'ousted');
  const turn = s.turn;
  const adv = dispatch(s, lunar, { type: 'time/advance', turns: 3 });
  assert.equal(adv.advanced, 0);
  assert.equal(adv.stoppedBy, 'ousted');
  assert.equal(s.turn, turn, 'time does not advance while the choice is pending');
  assert.match(dispatch(s, lunar, { type: 'budget/requestFunds' }).error, /afastado/);
  const st = query(s, lunar, 'director/status');
  assert.equal(st.actorId, 'nasa');
  assert.equal(st.canFound, false, 'the Corrida Lunar does not offer founding');
  const ids = st.candidates.map((c) => c.id);
  assert.equal(st.candidates[0].id, 'nasa', 'the agency that fired the director comes first');
  assert.equal(st.candidates[0].self, true, 'and is marked as a second chance');
  for (const id of ids) assert.ok(lunar.scenario.playableActors.includes(id), `${id} is a playable actor of the scenario`);
  assert.ok(st.tenure.fromTurn === 0 && st.tenure.toTurn >= 20);
});

test('fired → take another agency: the old one goes on under the AI, the world continues, save/load identical', () => {
  const s = newGame(lunar, { seed: 11, playerId: 'nasa' });
  steps(s, lunar, 30);
  fire(s, lunar);
  const before = serialize(s);
  assert.equal(serialize(deserialize(before, lunar)), before, 'save/load identical while the choice is pending');
  const oldMissions = s.missions.length;
  const r = dispatch(s, lunar, { type: 'director/take', actorId: 'cnsa' });
  assert.ok(r.ok, r.error);
  assert.equal(s.playerId, 'cnsa');
  assert.equal(s.director.ousted, null);
  assert.equal(isBlocked(s, lunar), null);
  assert.ok(s.actors.nasa, 'the old agency is still in the world');
  assert.ok(s.actors.nasa.cash >= 0 && s.actors.nasa.support >= 30, 'the new (AI) direction starts with the debt covered');
  assert.ok(Array.isArray(s.research.rivals.nasa), 'the old agency researches as a rival');
  assert.equal(s.research.rivals.cnsa, undefined);
  assert.equal(s.missions.length, 0, `the ${oldMissions} old missions left the player's lists`);
  assert.ok(Object.values(s.crew).some((p) => p.actorId === 'cnsa' && p.status === 'active'), 'the new agency brings its team');
  assert.ok(!Object.values(s.crew).some((p) => p.actorId === 'nasa' && p.status === 'active'));
  for (const inst of s.calendar) {
    const item = lunar.index.calendar[inst.id];
    if (inst.status === 'player') assert.equal(item.owner, 'cnsa', `${inst.id}: only the new agency's programs are the player's`);
  }
  assert.equal(s.director.tenures.length, 1);
  assert.equal(s.director.tenures[0].actorId, 'nasa');
  assert.equal(s.director.since, s.turn);
  const json = serialize(s);
  assert.equal(serialize(deserialize(json, lunar)), json, 'save/load identical after the take-over');
  // the world goes on: AI calendar, the old agency flies its programs, the year closes
  const turn = s.turn;
  const flights = Object.values(s.vehicleStats).reduce((n, v) => n + (v.flights || 0), 0);
  steps(s, lunar, 60);
  assert.ok(s.turn >= turn + 60);
  assert.ok(Object.values(s.vehicleStats).reduce((n, v) => n + (v.flights || 0), 0) > flights);
  assert.equal(s.playerId, 'cnsa');
  assert.ok(!s.log.some((l) => l.includes('erro')), s.log.filter((l) => l.includes('erro')).join(' | '));
  // deterministic: the same choices on the same save give the same world
  const a = deserialize(before, lunar);
  const b = deserialize(before, lunar);
  dispatch(a, lunar, { type: 'director/take', actorId: 'cnsa' });
  dispatch(b, lunar, { type: 'director/take', actorId: 'cnsa' });
  steps(a, lunar, 15);
  steps(b, lunar, 15);
  assert.equal(serialize(a), serialize(b));
});

test('fired in the campaign → found a new agency at today\'s date (same world, tech of now)', () => {
  const s = newGame(campaign, { seed: 5, playerId: 'nasa' });
  steps(s, campaign, 60);
  fire(s, campaign);
  const st = query(s, campaign, 'director/status');
  assert.equal(st.canFound, true);
  const sc = query(s, campaign, 'director/foundScenario');
  const year = s.startYear + Math.floor(s.turn / 52);
  assert.equal(sc.start.year, year, 'the wizard founds at the current date, not at the campaign start');
  const opts = query(s, campaign, 'agency/foundingOptions', sc);
  assert.equal(opts.year, year);
  const nation = opts.nations.find((n) => n.id === 'brazil') || opts.nations[0];
  const site = nation.sites.find((x) => x.launch) || nation.sites[0];
  const r = dispatch(s, campaign, {
    type: 'director/found', name: 'Agência Austral', short: 'AUSTR', kind: 'agency', nationId: nation.id, hq: site ? { id: site.id } : undefined,
    emblem: { shape: 'roundel', field: '#1f3a5f', glyph: 'rocket' }, money: 'medio', tech: 'pouca',
  });
  assert.ok(r.ok, r.error);
  const id = s.playerId;
  assert.ok(id.startsWith('custom_'));
  assert.equal(id, r.actorId);
  const a = s.actors[id];
  assert.equal(a.custom, true);
  assert.equal(a.born.year, year);
  assert.ok(s.actors.nasa, 'NASA goes on under the AI');
  const tech = foundingTech(campaign, 'pouca', year, sc);
  for (const n of tech.ids) assert.ok(s.research.unlocked.includes(n), `founding grant of ${year}: ${n}`);
  assert.equal(s.cap?.actorId, id);
  assert.equal(s.cap.playerPct, 100, 'a founded agency starts 100% the player\'s');
  assert.ok(s.news.some((n) => /Agência Austral/.test(n.headline)));
  const json = serialize(s);
  assert.equal(serialize(deserialize(json, campaign)), json);
  steps(s, campaign, 10);
  assert.equal(s.playerId, id);
  assert.ok(!s.gameOver);
});

test('old saves that ended with the director fired reopen the choice (before the campaign end only)', () => {
  const s = newGame(lunar, { seed: 3, playerId: 'isro' });
  steps(s, lunar, 25);
  // what v0.9.12 wrote: gameOver 'fired' and the end hooks
  s.gameOver = { reason: 'fired', turn: s.turn, summary: 'Depois de 20 semanas no vermelho, o governo perdeu a paciência e trocou a direção da agência.' };
  endGame(s, lunar);
  delete s.director;
  const loaded = deserialize(serialize(s), lunar);
  assert.equal(loaded.gameOver, null);
  assert.equal(loaded.director.ousted?.reason, 'fired');
  assert.equal(loaded.director.ousted.reopened, true);
  assert.equal(isBlocked(loaded, lunar), 'ousted');
  assert.ok(query(loaded, lunar, 'director/status').candidates.length > 0);
  assert.ok(dispatch(loaded, lunar, { type: 'director/take', actorId: 'esa' }).ok);
  steps(loaded, lunar, 5);
  assert.equal(loaded.playerId, 'esa');
  // the board's vote too; but a save already past its end stays over
  const b = newGame(lunar, { seed: 3, playerId: 'isro' });
  b.turn = b.endTurn + 1;
  b.gameOver = { reason: 'board', turn: b.turn, summary: 'conselho' };
  const back = deserialize(serialize(b), lunar);
  assert.equal(back.gameOver?.reason, 'board');
  assert.ok(!back.director?.ousted);
});

test('tenure history: every agency the player directed, in order; the epilogue mentions them', () => {
  const s = newGame(campaign, { seed: 9, playerId: 'nasa' });
  steps(s, campaign, 20);
  fire(s, campaign);
  const first = directorMove(s, campaign, engine);
  assert.ok(first && first !== 'nasa');
  steps(s, campaign, 20);
  fire(s, campaign);
  assert.equal(s.director.ousted?.actorId, first);
  assert.ok(query(s, campaign, 'director/candidates').find((c) => c.id === first)?.self, 'the agency that fired you is offered as a second chance');
  const second = directorMove(s, campaign, engine, { found: true });
  assert.ok(second.startsWith('custom_'));
  const ten = query(s, campaign, 'director/tenures');
  assert.deepEqual(ten.map((t) => t.actorId), ['nasa', first, second]);
  assert.deepEqual(ten.map((t) => t.reason), ['fired', 'fired', null]);
  assert.equal(ten[2].current, true);
  assert.ok(ten[0].toTurn < ten[1].fromTurn + 1 && ten[1].fromTurn <= ten[1].toTurn);
  const lines = legacyLines(s, campaign).join(' ');
  assert.match(lines, new RegExp(s.director.tenures[0].name.replace(/[()]/g, '.')));
  assert.match(lines, new RegExp(s.director.tenures[1].name.replace(/[()]/g, '.')));
});

test('a contract the fired director won becomes the old agency\'s AI job; open bids are withdrawn', () => {
  const s = newGame(lunar, { seed: 13, playerId: 'nasa' });
  steps(s, lunar, 5);
  s.contracts.push(
    { id: 'tc_won', status: 'awarded', winner: 'nasa', winningPrice: 100, advancePaidM: 30, deadlineTurn: s.turn + 40, missionId: 'm_x', title: 'Teste', client: 'Cliente', createdTurn: s.turn },
    { id: 'tc_bid', status: 'bidding', playerBid: { price: 80 }, closeTurn: s.turn + 10, deadlineTurn: s.turn + 50, title: 'Lance', client: 'Cliente', createdTurn: s.turn, rivals: [] },
  );
  fire(s, lunar);
  assert.ok(dispatch(s, lunar, { type: 'director/take', actorId: 'esa' }).ok);
  const won = s.contracts.find((c) => c.id === 'tc_won');
  assert.equal(won.status, 'closed');
  assert.equal(won.winner, 'nasa');
  assert.equal(won.missionId, null);
  assert.ok(won.ai && won.ai.deliverTurn > s.turn - 1 && won.ai.done == null);
  const bid = s.contracts.find((c) => c.id === 'tc_bid');
  assert.equal(bid.status, 'open');
  assert.equal(bid.playerBid, null);
});

test('the shared bot handles the choice and the run goes on (golden bot + Phase B bot)', () => {
  const s = newGame(lunar, { seed: 17, playerId: 'spacex' });
  steps(s, lunar, 10);
  fire(s, lunar);
  const best = query(s, lunar, 'director/candidates').sort((a, b) => b.prestige - a.prestige || b.budget - a.budget)[0];
  assert.equal(directorMove(s, lunar, engine), best.id, 'the strongest agency left');
  assert.equal(s.playerId, best.id);
  assert.equal(directorMove(s, lunar, engine), null, 'nothing pending any more');
});

test('second chance: the player goes back to the agency that fired them, with debt covered and nothing handed over', () => {
  const s = newGame(lunar, { seed: 11, playerId: 'nasa' });
  steps(s, lunar, 20);
  const missions = s.missions.length;
  fire(s, lunar);
  assert.equal(s.director.ousted?.actorId, 'nasa');
  const r = dispatch(s, lunar, { type: 'director/take', actorId: 'nasa' });
  assert.ok(r.ok && r.retake, JSON.stringify(r));
  assert.equal(s.playerId, 'nasa');
  assert.equal(s.director.ousted, null);
  assert.ok(s.actors.nasa.cash >= 0, 'debt covered');
  assert.ok(s.actors.nasa.support >= 30, 'support back to 30');
  assert.equal(s.finance.debtWeeks, 0);
  assert.equal(s.missions.length, missions, 'missions stay with the player');
  assert.equal(s.director.tenures.length, 1, 'the first tenure is recorded');
  const turn = s.turn;
  steps(s, lunar, 3);
  assert.ok(s.turn > turn, 'time moves again');
  const back = deserialize(serialize(s));
  assert.deepEqual(back, deserialize(serialize(back)));
});

test('resign: the drawer action leaves the direction and opens the same choice (own agency first)', () => {
  const s = newGame(lunar, { seed: 13, playerId: 'nasa' });
  steps(s, lunar, 5);
  const r = dispatch(s, lunar, { type: 'director/resign' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(s.director.ousted?.reason, 'resigned');
  assert.equal(isBlocked(s, lunar), 'ousted');
  const st = query(s, lunar, 'director/status');
  assert.equal(st.candidates[0].id, 'nasa');
  assert.equal(dispatch(s, lunar, { type: 'director/resign' }).ok, false, 'already out');
  const other = st.candidates.find((c) => !c.self).id;
  assert.ok(dispatch(s, lunar, { type: 'director/take', actorId: other }).ok);
  assert.equal(s.playerId, other);
});

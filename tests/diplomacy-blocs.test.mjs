// Bloc dynamics in src/sim/diplomacy.js: agencies leave/join blocs for real causes (government alignment,
// a new government, tension, money), companies never walk out on their own, news are less repetitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, tick } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as dip from '../src/sim/diplomacy.js';

const ctxOf = (s) => ({ data, rng: (l = '') => rngFor(s.seed, s.turn, 'diplomacy', l), date: turnToDate(s.turn, s.startYear) });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

const labels = (f) => f.list.map((x) => x.label);

test('leaveUtility: companies are associates and never leave on their own', () => {
  const s = newGame(data, { seed: 3, playerId: 'nasa' });
  const f = dip.leaveUtility(s, data, 'spacex', s.blocs.artemis_accords);
  assert.ok(f.u < -500);
});

test('leaveUtility: a cold government and a fresh one push an agency out; a warm one keeps it', () => {
  const s = newGame(data, { seed: 4, playerId: 'nasa' });
  const bloc = s.blocs.artemis_accords;
  const base = dip.leaveUtility(s, data, 'isro', bloc);
  assert.ok(labels(base).includes('alinhamento do governo'));
  assert.ok(base.u < 0, `ISRO não deveria querer sair no início (${base.u})`);
  // India changes government to the faction that is lukewarm about Artemis, and it just happened
  const nid = s.world.actorNation.isro;
  const nd = data.politics.nations.find((n) => n.id === nid);
  const cold = nd.factions.slice().sort((a, b) => (a.alignment?.artemis_accords ?? 0) - (b.alignment?.artemis_accords ?? 0))[0];
  s.world.nations[nid].government.exec = cold.id;
  s.actors.isro.ai.memory.newGovTurn = s.turn;
  const after = dip.leaveUtility(s, data, 'isro', bloc);
  assert.ok(labels(after).includes('governo novo revê compromissos'));
  assert.ok(after.u > base.u + 10, `${base.u} -> ${after.u}`);
  // JAXA under a pro-Artemis government stays far from the door
  assert.ok(dip.leaveUtility(s, data, 'jaxa', bloc).u < after.u);
});

test('election: only a real change of government is remembered as a new government', () => {
  const s = newGame(data, { seed: 5, playerId: 'nasa' });
  s.signals = [{ type: 'election', actorId: 'isro', result: 'continuity', turn: s.turn }];
  dip.tick(s, data, ctxOf(s));
  assert.equal(s.actors.isro.ai.memory.newGovTurn, undefined);
  s.signals = [{ type: 'election', actorId: 'isro', result: 'change', turn: s.turn }];
  const c0 = s.actors.isro.ai.cooperation;
  dip.tick(s, data, ctxOf(s));
  assert.equal(s.actors.isro.ai.memory.newGovTurn, s.turn);
  assert.notEqual(s.actors.isro.ai.cooperation, c0);
});

test('campaigns: blocs are no longer frozen, membership stays consistent', () => {
  let changes = 0;
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const s = newGame(data, { seed, playerId: 'esa' });
    while (s.turn < 259 && !s.gameOver) {
      s.decisions = s.decisions.filter((d) => !d.blocking);
      s.activeLaunch = null;
      tick(s, data);
    }
    changes += (s.geo?.blocChanges || []).length;
    for (const b of Object.values(s.blocs)) for (const m of b.members) assert.equal(s.actors[m].bloc, b.id);
    for (const c of (s.geo?.blocChanges || []).filter((x) => x.kind === 'agency')) {
      assert.ok(s.news.some((n) => n.tags.includes('bloco') && n.turn >= c.turn - 1 && n.turn <= c.turn + 1) || s.news.length >= 200, 'notícia da mudança de bloco');
    }
    // routine AI-AI expirations are not in the feed (only in the log)
    assert.ok(!s.news.some((n) => n.icon === '⌛' && !n.actors.includes('esa')), 'expiração IA-IA no feed');
  }
  assert.ok(changes >= 3, `só ${changes} mudanças de bloco em 6 campanhas`);
});

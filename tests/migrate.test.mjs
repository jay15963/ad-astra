// Save migration v1 → v2 and pt-BR rejections (EXPANSION.md §11, §13.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDataNode } from '../src/core/data.js';
import { deserialize, serialize, dispatch, isBlocked, SAVE_VERSION } from '../src/core/engine.js';
import { migrate, SaveError, SAVE_ERROR_MESSAGES, MIGRATIONS, registerMigration, targetVersion } from '../src/core/migrate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const v1Text = readFileSync(path.join(root, 'tests', 'fixtures', 'save-v1-t120.json'), 'utf8');

const MSG = {
  newer: 'Este save é de uma versão mais nova do Ad Astra. Atualize o jogo para continuar.',
  unreadable: 'Não foi possível ler este save. Ele pode estar corrompido ou ser de uma versão antiga demais.',
  scenario: 'Este save usa um cenário que não existe nesta versão.',
};

function rejects(fn, code) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof SaveError, `SaveError, veio ${e?.name}`);
    assert.equal(e.code, code);
    assert.equal(e.message, MSG[code]);
    return e;
  }
  assert.fail(`deveria rejeitar com ${code}`);
}

test('binding pt-BR messages', () => {
  assert.deepEqual(SAVE_ERROR_MESSAGES, MSG);
  assert.equal(SAVE_VERSION, 4); // v2 + v2 → v3 (investors.js, Phase B) + v3 → v4 (research.js, Missões v2)
});

test('v1 fixture (Corrida Lunar, week 120, mission in transit) migrates to v2', () => {
  const raw = JSON.parse(v1Text);
  assert.equal(raw.version, 1);
  assert.ok(raw.missions.some((m) => m.status === 'transit'), 'fixture tem missão em trânsito');
  const s = deserialize(v1Text, data);
  assert.equal(s.version, 4); // v1 → v2 → v3 → v4 (investors.js and research.js register theirs through the engine)
  assert.equal(s.scenarioId, 'lunar_race');
  assert.equal(s.turn, raw.turn);
  assert.deepEqual(s.clock, {
    eraId: 'e4', stepWeeks: 1, bandIdx: 4, steps: raw.turn, eraStartTurn: 0, pendingEra: null, paceMult: 1,
    turnWeeks: 1, finalTurn: null, endingPushed: false,
  });
  assert.deepEqual(s.eraHistory, []);
  assert.deepEqual(s.lifecycle, { applied: {}, tombstones: {}, aliases: {} });
  assert.deepEqual(s.annals, {});
  assert.deepEqual(s.dataPacks, {});
  // missions in planning keep their hardware (no retro-nulling)
  for (const m of s.missions.filter((x) => x.status === 'planning')) {
    const o = raw.missions.find((x) => x.id === m.id);
    assert.equal(m.vehicleId, o.vehicleId);
  }
  // round trip of the migrated state is stable
  assert.equal(serialize(deserialize(serialize(s), data)), serialize(s));
});

test('migrated v1 save plays 20 turns without errors', () => {
  const s = deserialize(v1Text, data);
  const logBefore = s.log.length;
  let turns = 0;
  for (let i = 0; i < 60 && turns < 20 && !s.gameOver; i++) {
    for (const d of s.decisions.slice()) {
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
    }
    if (s.activeLaunch) {
      let g = 0;
      while (s.activeLaunch && g++ < 200) {
        const al = s.activeLaunch;
        if (al.pendingIntervention) dispatch(s, data, { type: 'launch/choose', optionId: (al.pendingIntervention.options.find((o) => !o.disabled) || al.pendingIntervention.options[0]).id });
        else if (al.act === 'prelaunch') dispatch(s, data, { type: 'launch/countdown' });
        else if (al.pendingHold) dispatch(s, data, { type: 'launch/hold', choice: 'go' });
        else if (al.act === 'result') dispatch(s, data, { type: 'launch/finish' });
        else dispatch(s, data, { type: 'launch/step' });
      }
    }
    if (isBlocked(s, data)) continue;
    const r = dispatch(s, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
    assert.equal(r.ok, true, r.error);
    turns += r.advanced;
  }
  assert.equal(turns, 20);
  const errs = s.log.slice(Math.max(0, logBefore - 80)).filter((l) => l.includes('erro'));
  assert.deepEqual(errs, []);
  assert.equal(s.clock.steps, JSON.parse(v1Text).turn + 20);
});

test('garbage, missing fields and bad versions: "Não foi possível ler este save…"', () => {
  rejects(() => deserialize('{nope', data), 'unreadable');
  rejects(() => deserialize('', data), 'unreadable');
  rejects(() => deserialize('null', data), 'unreadable');
  rejects(() => deserialize('[1,2]', data), 'unreadable');
  rejects(() => deserialize(JSON.stringify({ version: 1 }), data), 'unreadable');
  rejects(() => deserialize(JSON.stringify({ version: 'x', turn: 1 }), data), 'unreadable');
  const raw = JSON.parse(v1Text);
  delete raw.actors;
  const e = rejects(() => deserialize(JSON.stringify(raw), data), 'unreadable');
  assert.match(e.detail, /actors/);
});

test('newer version: "Este save é de uma versão mais nova…"', () => {
  const raw = JSON.parse(v1Text);
  raw.version = 99;
  const e = rejects(() => deserialize(JSON.stringify(raw), data), 'newer');
  assert.equal(e.version, 99);
});

test('unknown scenario: "Este save usa um cenário que não existe nesta versão."', () => {
  const raw = JSON.parse(v1Text);
  raw.scenarioId = 'cenario_que_nao_existe';
  rejects(() => deserialize(JSON.stringify(raw), data), 'scenario');
  // without data the scenario is not checked (tools that only parse)
  assert.equal(deserialize(JSON.stringify(raw)).scenarioId, 'cenario_que_nao_existe');
});

test('v2 saves load unchanged; string input is never mutated, object input is migrated in place', () => {
  const s = deserialize(v1Text, data);
  const text = serialize(s);
  assert.equal(serialize(deserialize(text, data)), text);
  const obj = JSON.parse(v1Text);
  const out = migrate(obj, data);
  assert.equal(out.version, 4);
});

test('later phases register migrations without editing the table (v2 → v3 by investors.js, v3 → v4 by research.js; a test v4 → v5)', () => {
  assert.equal(targetVersion(), 4);
  assert.equal(typeof MIGRATIONS[2], 'function', 'v2 → v3 registered on import of investors.js');
  assert.equal(typeof MIGRATIONS[3], 'function', 'v3 → v4 registered on import of research.js');
  registerMigration(4, (s) => { s.extra = { ok: true }; return s; });
  try {
    assert.equal(targetVersion(), 5);
    const s = migrate(v1Text, data);
    assert.equal(s.version, 5);
    assert.equal(s.cap, null);
    assert.deepEqual(s.extra, { ok: true });
  } finally {
    delete MIGRATIONS[4];
  }
  assert.equal(targetVersion(), 4);
});

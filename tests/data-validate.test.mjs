// Data validator (tools/validate-data.mjs + tools/validate/rules.js): the repo is clean, and each rule of §4.4
// catches a broken pack fed in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRepo, loadRepoInput } from '../tools/validate-data.mjs';
import { checkData, errorsOf } from '../tools/validate/rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = () => JSON.parse(JSON.stringify(loadRepoInput(root).input));
const errs = (input, opts) => errorsOf(checkData(input, opts));
const has = (list, re) => list.some((i) => re.test(`${i.path} ${i.message}`));

test('the repository data is valid (no errors)', () => {
  const r = validateRepo(root);
  const e = errorsOf(r);
  assert.deepEqual(e, [], e.map((i) => `${i.path}: ${i.message}`).join('\n'));
  assert.ok(r.stats.entities > 400);
  assert.ok(r.stats.bootBytes < 1.6 * 1024 * 1024, 'boot budget');
  assert.ok(r.density[1957] >= 1 && r.density[1961] >= 1, 'density counts the e1 seeds');
});

test('CLI exits 0 and prints pt-BR summary; --json is machine readable', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'tools/validate-data.mjs'), '--quiet'], { encoding: 'utf8' });
  assert.match(out, /Dados válidos/);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools/validate-data.mjs'), '--json', '--pack', 'e1'], { encoding: 'utf8' }));
  assert.equal(json.ok, true);
  assert.ok(json.issues.every((i) => i.pack === 'e1'));
});

test('duplicate id across packs is an error (patches.json is the way)', () => {
  const inp = base();
  inp.packs.e1.vehicles.vehicles.push({ ...inp.packs['legacy-e4'].vehicles.vehicles[0], availableFrom: { year: 1960, month: 1 } });
  assert.ok(has(errs(inp), /id repetido/));
});

test('broken references are errors with file#id.field paths', () => {
  const inp = base();
  const m = inp.packs.e1.calendar.missions[0];
  m.vehicleId = 'foguete_fantasma';
  m.destination = 'lugar_nenhum';
  m.owner = 'agencia_x';
  const e = errs(inp);
  assert.ok(has(e, /eras\/e1\/calendar\.json#sputnik1\.vehicleId lançador desconhecido: foguete_fantasma/));
  assert.ok(has(e, /destination destino desconhecido/));
  assert.ok(has(e, /owner ator desconhecido/));
});

test('entity dated before its era is an error (results would depend on loaded packs)', () => {
  const inp = base();
  inp.packs.e1.vehicles.vehicles[0].availableFrom = { year: 1940, month: 1 };
  assert.ok(has(errs(inp), /antes do início da era e1/));
});

test('truth layer × year and source rules', () => {
  const inp = base();
  inp.packs.e1.calendar.missions[0].truthLayer = 'especulacao';
  delete inp.packs.e1.calendar.missions.find((m) => m.id === 'vostok1').source;
  const e = errs(inp);
  assert.ok(has(e, /sputnik1\.truthLayer especulacao não combina com 1957/));
  assert.ok(has(e, /vostok1\.source camada fato precisa de "source"/));
  const inp2 = base();
  inp2.packs.e1.vehicles.vehicles[0].truthLayer = 'fato';
  inp2.packs.e1.vehicles.vehicles[0].availableFrom = { year: 2100, month: 1 };
  assert.ok(has(errs(inp2), /fato não combina com 2100/));
});

test('capacity: no route may exceed LEO', () => {
  const inp = base();
  inp.packs.e1.vehicles.vehicles[0].capacity.gto = 9;
  assert.ok(has(errs(inp), /capacidade gto .* maior que a de LEO/));
});

test('monthBase must match the legacy file; month 0 in a monthBase-1 file is an error', () => {
  const inp = base();
  inp.packs.e1.calendar.monthBase = 0;
  assert.ok(has(errs(inp), /monthBase deve ser 1/));
  const inp2 = base();
  inp2.packs.e1.calendar.missions[0].planned.month = 0;
  assert.ok(has(errs(inp2), /mês 0 num arquivo com monthBase 1/));
});

test('lifecycle: merge cycles, out-of-order identities, references before birth', () => {
  const inp = base();
  inp.packs.core.lineages = { lineages: [
    { id: 'aa', kind: 'agency', born: { year: 1950, month: 0 }, identities: [{ from: { year: 1960, month: 0 }, name: 'A2' }, { from: { year: 1950, month: 0 }, name: 'A1' }] },
    { id: 'bb', kind: 'agency', born: { year: 1950, month: 0 }, identities: [{ from: 1950, name: 'B' }] },
    { id: 'late', kind: 'agency', identities: [{ from: 1970, name: 'Tardia' }] },
  ] };
  inp.packs.core.lifecycle = { events: [
    { id: 'm1', date: { year: 1960, month: 0 }, op: 'merge', from: ['aa'], into: 'bb' },
    { id: 'm2', date: { year: 1961, month: 0 }, op: 'merge', from: ['bb'], into: 'aa' },
    { id: 'late_born', date: { year: 1970, month: 0 }, op: 'birth', actor: 'late' },
  ] };
  inp.packs.e1.calendar.missions[0].owner = 'late';
  const e = errs(inp);
  assert.ok(has(e, /ciclo de fusões/));
  assert.ok(has(e, /identidades fora de ordem/));
  assert.ok(has(e, /late não existe em 1957/));
});

test('manifest: era windows must be contiguous 1950–2999 and era.json must agree', () => {
  const inp = base();
  inp.manifest.packs.find((p) => p.id === 'e3').years = [2001, 2025];
  assert.ok(has(errs(inp), /deveria começar em 2000/));
  const inp2 = base();
  inp2.packs.e2.era.from = 1977;
  assert.ok(has(errs(inp2), /diferem do manifesto/));
  const inp3 = base();
  inp3.packs.e2.era.chapters.reverse();
  assert.ok(has(errs(inp3), /capítulos fora de ordem/));
});

test('scenarios: playable actors must exist; index entries need a file', () => {
  const inp = base();
  inp.scenarios.campaign.playable.actors.push('agencia_fantasma');
  inp.scenarioIndex.scenarios.push({ id: 'sem_arquivo', kind: 'scenario', name: 'X' });
  const e = errs(inp);
  assert.ok(has(e, /ator jogável desconhecido: agencia_fantasma/));
  assert.ok(has(e, /sem_arquivo cenário sem arquivo/));
});

test('pt-BR text checks: leftovers and unknown placeholders; "todo" (Portuguese) is fine', () => {
  const inp = base();
  inp.packs.e1.calendar.missions[0].description = 'TODO escrever';
  inp.packs.e1.calendar.missions[1].description = 'Olá {inexistente}, todo o mundo viu.';
  const e = errs(inp);
  assert.ok(has(e, /marcador proibido: "TODO"/));
  assert.ok(has(e, /marcador \{inexistente\} desconhecido/));
  const ok = base();
  ok.packs.e1.calendar.missions[1].description = 'Todo o mundo ouviu {actor}.';
  assert.deepEqual(errs(ok), []);
});

test('budgets: an era pack over 350 KB is an error', () => {
  const inp = base();
  inp.sizes.e2 = { era: 400 * 1024 };
  assert.ok(has(errs(inp), /limite 350 KB/));
});

test('schema errors surface through the validator with the item path', () => {
  const inp = base();
  inp.packs.e1.spacecraft.spacecraft[0].crew = -1;
  assert.ok(has(errs(inp), /eras\/e1\/spacecraft\.json#ps1\.crew/));
});

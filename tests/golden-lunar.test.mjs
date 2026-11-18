// Golden (EXPANSION.md §13.1): the Corrida Lunar at dt = 1 must give the same per-slice hashes as v0.5
// (fixture recorded by tools/golden.mjs --record before any src change). A failure lists run, turn and the
// slices that diverged. An intended change regenerates the fixture with a written reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDataNode } from '../src/core/data.js';
import { computeGolden, diffGolden, GOLDEN_PATH } from '../tools/golden.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

test('golden: Corrida Lunar identical to v0.5 (3 seeds × 5 actors, turns 26/52/130/260)', () => {
  const expected = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  assert.equal(Object.keys(expected.runs).length, 15);
  const actual = computeGolden(data);
  const diff = diffGolden(expected, actual);
  assert.deepEqual(diff, [], `golden diferente:\n${diff.slice(0, 20).join('\n')}`);
});

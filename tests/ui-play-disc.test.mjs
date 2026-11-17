// Navbar centre disc (time): the long-press "Próximo evento" runs week by week so the ring can show progress.
// That is only correct if one-week steps with stopOnEvent stop exactly where a single 26-week advance stops.
// Plus static checks that the old action bar is gone and the disc keeps its contract (DESIGN §3.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, serialize, deserialize, isBlocked } from '../src/core/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

/** What runToEvent (app.js) does, without the DOM: 1-week dispatches until a stop, a block or 26 weeks. */
function stepwise(state, max = 26) {
  let total = 0;
  let last = null;
  while (total < max) {
    if (state.gameOver || isBlocked(state)) break;
    const r = dispatch(state, data, { type: 'time/advance', weeks: 1, stopOnEvent: true });
    assert.equal(r.ok, true, r.error);
    last = r;
    total += r.advanced;
    if (r.stoppedBy || !r.advanced) break;
  }
  return { advanced: total, stoppedBy: last?.stoppedBy || (total ? null : isBlocked(state)) };
}

test('disc: week-by-week "Próximo evento" stops where advance(26, stopOnEvent) stops', () => {
  for (const playerId of data.scenario.playableActors.slice(0, 3)) {
    let s = newGame(data, { seed: 7, playerId });
    for (let round = 0; round < 12 && !s.gameOver; round++) {
      // settle decisions so the clock can run (pick the first available choice)
      for (const d of s.decisions.slice()) {
        const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
        dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
      }
      if (s.activeLaunch || isBlocked(s)) break;
      const a = deserialize(serialize(s));
      const b = deserialize(serialize(s));
      const one = dispatch(a, data, { type: 'time/advance', weeks: 26, stopOnEvent: true });
      const steps = stepwise(b);
      assert.equal(steps.advanced, one.advanced, `${playerId} round ${round}: weeks`);
      assert.equal(steps.stoppedBy || null, one.stoppedBy || null, `${playerId} round ${round}: stop reason`);
      assert.equal(serialize(b), serialize(a), `${playerId} round ${round}: same world`);
      // carry on from there
      s = a;
    }
  }
});

test('shell: action bar replaced by the navbar disc', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'ui', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.ok(!/timebar/.test(app), 'app.js still builds .timebar');
  assert.ok(!/\.timebar|--act-h/.test(css), 'styles.css still styles the old action bar');
  // tap = the old "+1 semana" dispatch; hold = stopOnEvent run; haptic; one-time hint
  assert.match(app, /advance\(1, false\)/);
  assert.match(app, /type: 'time\/advance', weeks: 1, stopOnEvent: true/);
  assert.match(app, /HOLD_MS = 450/);
  assert.match(app, /store\.vibrate\(15\)/);
  assert.match(app, /Segure para avançar até o próximo evento/);
  // blocked states route instead of going dead
  for (const label of ["'Decidir'", "'Lançar'", "'Resumo'"]) assert.ok(app.includes(label), `disc label ${label}`);
  // game over: the disc is the way back to the campaign summary (not a dead button)
  assert.match(app, /ui\.lookingAfterEnd = false;\s*renderAll\(\)/);
  // a run owns the clock: no extra week from the Painel link / keyboard while it runs
  assert.match(app, /if \(ui\.run\) return;/);
  // 7 equal slots (6 tabs + disc at index 3): the disc sits on the screen centre
  assert.match(app, /const DISC_AT = 3;/);
  assert.equal((app.match(/^  \{ id: '[a-z]+', label: '[^']+' \},$/gm) || []).length, 6, '6 navbar tabs');
  // CSmanager look: raised 50px amber disc, ring in the bar colour, conic progress ring, spin
  for (const needle of ['.tab-central', '.tab-disc', 'var(--act)', '0 0 0 4px var(--s1)', 'conic-gradient', '.tab-central.girando', '.tab-central:disabled .tab-disc']) {
    assert.ok(css.includes(needle), `styles.css missing ${needle}`);
  }
  // the accessible path without a long-press (Painel head links)
  const dash = fs.readFileSync(path.join(root, 'src', 'ui', 'dashboard.js'), 'utf8');
  assert.match(dash, /advanceToEvent/);
  assert.match(dash, /'Próximo evento'/);
});

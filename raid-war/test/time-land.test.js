import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { windowsOn, windowAt, nextWindow } from '../src/time.js';
import { maxGoalTiles, validateGoal, validateShrink } from '../src/land.js';
import { makeEnv, GOAL } from './helpers.js';

const cfg = loadConfig();
const iso = (ms) => new Date(ms).toISOString();

test('windows follow Europe/Copenhagen across the 25 October 2026 clock change', () => {
  const before = windowsOn('2026-10-24', cfg).map((w) => iso(w.startMs));
  const after = windowsOn('2026-10-26', cfg).map((w) => iso(w.startMs));
  assert.deepEqual(before, ['2026-10-24T14:00:00.000Z', '2026-10-24T17:00:00.000Z', '2026-10-24T20:00:00.000Z']); // UTC+2
  assert.deepEqual(after, ['2026-10-26T15:00:00.000Z', '2026-10-26T18:00:00.000Z', '2026-10-26T21:00:00.000Z']); // UTC+1
  const change = windowsOn('2026-10-25', cfg);
  assert.equal(iso(change[0].startMs), '2026-10-25T15:00:00.000Z'); // 16:00 local, already winter time
});

test('windows are 90 minutes and only those are active', () => {
  const w = windowsOn('2026-10-05', cfg)[1];
  assert.equal(w.endMs - w.startMs, 90 * 60000);
  assert.equal(windowAt(w.startMs, cfg).index, 1);
  assert.equal(windowAt(w.endMs - 1, cfg).index, 1);
  assert.equal(windowAt(w.endMs, cfg), null);
  assert.equal(windowAt(w.startMs - 1, cfg), null);
});

test('nextWindow picks the right instant after the change', () => {
  const t = Date.UTC(2026, 9, 24, 21, 0); // after Oct 24 22:00 local
  assert.equal(iso(nextWindow(t, 2, cfg).startMs), '2026-10-25T21:00:00.000Z');
});

test('land amount: smaller of 10 percent and 20 tiles, never below 2', () => {
  assert.equal(maxGoalTiles(15, cfg), 2);
  assert.equal(maxGoalTiles(100, cfg), 10);
  assert.equal(maxGoalTiles(200, cfg), 20);
  assert.equal(maxGoalTiles(5000, cfg), 20);
});

test('war goal rules', () => {
  const env = makeEnv();
  const A = env.world.nation('vik'), T = env.world.nation('sax');
  assert.equal(validateGoal(GOAL, A, T, cfg).ok, true);
  assert.equal(validateGoal(Array.from({ length: 21 }, (_, i) => `${40 + (i % 2)},${40 + Math.floor(i / 2)}`), A, T, cfg).reason, 'goal_too_large');
  assert.equal(validateGoal(['59,49'], A, T, cfg).reason, 'goal_includes_capital');
  assert.equal(validateGoal(['10,10'], A, T, cfg).reason, 'goal_tile_not_owned_by_target');
  assert.equal(validateGoal(['50,45'], A, T, cfg).reason, 'goal_tile_not_reachable');
  assert.equal(validateGoal([], A, T, cfg).ok, false);
  // a 1-wide strip taken from the middle of a 3-wide target would split it
  const split = { tiles: new Set(['44,40', '45,40', '46,40']), capital: '44,40' };
  assert.equal(validateGoal(['45,40'], { tiles: new Set(['45,41']) }, split, { land: { pct: 100, maxTiles: 20, minTiles: 2 } }).reason, 'goal_splits_target');
  // shrink only
  assert.equal(validateShrink(GOAL, GOAL.slice(0, 5)).ok, true);
  assert.equal(validateShrink(GOAL, [...GOAL, '42,40']).ok, false);
  assert.equal(validateShrink(GOAL, ['50,50']).ok, false);
});

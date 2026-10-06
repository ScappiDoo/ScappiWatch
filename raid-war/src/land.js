import { connected, parseTile, tk, NEIGHBORS } from './world.js';

/** Largest war goal allowed for a target: smaller of pct and cap, never below the minimum. */
export function maxGoalTiles(targetTileCount, cfg) {
  const { pct, maxTiles, minTiles } = cfg.land;
  return Math.max(minTiles, Math.min(Math.floor((targetTileCount * pct) / 100), maxTiles));
}

const touches = (k, set) => {
  const [x, y] = parseTile(k);
  return NEIGHBORS.some(([dx, dy]) => set.has(tk(x + dx, y + dy)));
};

/**
 * Section 7 land rules. Returns { ok, reason }.
 *  - amount within the cap, tiles unique and owned by the target
 *  - never the capital, never the last tile
 *  - each tile touches the attacker's territory or the target's border
 *  - the target's remaining territory must stay in one piece
 */
export function validateGoal(goalKeys, attacker, target, cfg) {
  const goal = new Set(goalKeys);
  if (!goal.size || goal.size !== goalKeys.length) return { ok: false, reason: 'goal_empty_or_duplicate' };
  if (goal.size > maxGoalTiles(target.tiles.size, cfg)) return { ok: false, reason: 'goal_too_large' };
  for (const k of goal) if (!target.tiles.has(k)) return { ok: false, reason: 'goal_tile_not_owned_by_target' };
  if (goal.has(target.capital)) return { ok: false, reason: 'goal_includes_capital' };
  if (goal.size >= target.tiles.size) return { ok: false, reason: 'goal_takes_last_tile' };
  for (const k of goal) {
    const [x, y] = parseTile(k);
    const onTargetBorder = NEIGHBORS.some(([dx, dy]) => !target.tiles.has(tk(x + dx, y + dy)));
    if (!onTargetBorder && !touches(k, attacker.tiles)) return { ok: false, reason: 'goal_tile_not_reachable' };
  }
  const rest = [...target.tiles].filter((k) => !goal.has(k));
  if (!connected(rest)) return { ok: false, reason: 'goal_splits_target' };
  return { ok: true };
}

/** A goal may only shrink after declaration. */
export function validateShrink(oldGoal, newGoal) {
  const old = new Set(oldGoal);
  if (!newGoal.length || newGoal.length > old.size) return { ok: false, reason: 'goal_cannot_grow' };
  for (const k of newGoal) if (!old.has(k)) return { ok: false, reason: 'goal_cannot_grow' };
  return { ok: true };
}

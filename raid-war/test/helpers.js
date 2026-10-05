import { loadConfig } from '../src/config.js';
import { EventLog } from '../src/eventlog.js';
import { World } from '../src/world.js';
import { WarManager, Presence } from '../src/war.js';
import { Detector } from '../src/detect.js';
import { Guard } from '../src/guard.js';
import { Staff } from '../src/staff.js';

export const T0 = Date.UTC(2026, 9, 5, 10, 0, 0); // 5 Oct 2026, 12:00 Copenhagen
export const GOAL = Array.from({ length: 10 }, (_, i) => `40,${40 + i}`); // the western edge strip, touching vik

export function makeEnv(overrides = {}, { startAt = T0, homeWindow = 0 } = {}) {
  const cfg = loadConfig(overrides);
  const clock = { t: startAt };
  const now = () => clock.t;
  const log = new EventLog({ clock: now, retentionMs: cfg.retention.logDays * 86400000 });
  const world = new World({ cfg, clock: now, width: 128, height: 128 });
  const grid = (x0, x1, y0, y1) => { const t = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) t.push([x, y]); return t; };
  world.addNation({ id: 'vik', tiles: grid(20, 39, 40, 49), capital: [20, 40], treasury: 1000, spawns: [{ x: 21.5, y: 45.5 }] });
  world.addNation({
    id: 'sax', tiles: grid(40, 59, 40, 49), capital: [59, 49], treasury: 2000, homeWindow,
    spawns: [{ x: 58.5, y: 45.5 }, { x: 58.5, y: 46.5 }, { x: 58.5, y: 44.5 }],
  });
  for (let i = 1; i <= 5; i++) {
    world.addMember('vik', { id: `v${i}`, rank: i === 1 ? 'leader' : 'member', ip: `10.0.0.${i}` });
    world.addMember('sax', { id: `s${i}`, rank: i === 1 ? 'leader' : 'member', ip: `10.0.1.${i}` });
  }
  const notes = [];
  const presence = new Presence();
  const detector = new Detector({ cfg, log, clock: now });
  const hooks = {
    notify: (k, p) => notes.push({ k, ...p }),
    lockStorage: (nid, on) => notes.push({ k: 'lock', nid, on }),
    wear: (id, pct) => notes.push({ k: 'wear', id, pct }),
    input: (id, tick, intent, raid) => detector.onInput(id, raid.startMs + tick * raid.tickMs, intent, raid.setup.raidId),
    hitCheck: (i) => detector.onHitCheck(i),
    reaction: (id, ms, raid) => detector.onReaction(id, ms, raid.setup.raidId, raid.startMs),
    pos: (id, ms, x, y) => detector.record(id, ms, 'pos', { x, y }),
    rejected: (id, reason, tick, raid) => detector.onRejected(id, raid.startMs + tick * raid.tickMs, reason),
  };
  const wm = new WarManager({ world, log, cfg, clock: now, hooks, presence });
  const guard = new Guard({ cfg, secret: 'test-secret', log, clock: now, detector });
  const staff = new Staff({ manager: wm, isStaff: (id) => id.startsWith('staff'), clock: now });
  return { cfg, clock, log, world, wm, presence, detector, guard, staff, notes, hooks };
}

export const declare = (env, over = {}) =>
  env.wm.declare({ attackerId: 'vik', targetId: 'sax', byAccount: 'v1', reason: 'They insulted our jarl', goalTiles: GOAL, ...over }, env.clock.t);

export function connectAll(env, beforeMs) {
  for (const n of ['vik', 'sax']) for (const id of env.world.nation(n).members.keys()) {
    env.presence.disconnect(id);
    env.presence.connect(id, beforeMs);
  }
}

/** Move the clock to the first window of a war and start the raid with everyone online. */
export function startRaid(env, war) {
  const s = war.slot;
  connectAll(env, s.startMs - 20 * 60000);
  env.clock.t = s.startMs - 5 * 60000;
  env.wm.tick(env.clock.t); // storage lock fires at -30min
  for (const id of ['v1', 'v2', 'v3', 'v4', 'v5', 's1', 's2', 's3', 's4', 's5']) env.presence.touch(id, s.startMs - 30000);
  env.clock.t = s.startMs;
  env.wm.tick(env.clock.t);
  return env.wm.raids.get(war.raidId);
}

export function run(env, raid, ticks = 1) {
  for (let i = 0; i < ticks; i++) {
    env.clock.t = raid.startMs + raid.tick * raid.tickMs;
    env.wm.tick(env.clock.t);
  }
}

export function goto(env, raid, id, x, y, eps = 0.3) {
  const p = raid.players.get(id);
  for (let i = 0; i < 4000; i++) {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d <= eps) break;
    raid.enqueue(id, { t: 'move', dx: (x - p.x) / d, dy: (y - p.y) / d });
    run(env, raid, 1);
  }
  raid.enqueue(id, { t: 'move', dx: 0, dy: 0 });
  run(env, raid, 1);
}

export function endWindow(env, raid) {
  env.clock.t = raid.setup.endMs;
  env.wm.tick(env.clock.t);
}

export const joinAll = (env, raid, ids) => { for (const id of ids) env.wm.joinRaid(id, env.clock.t); run(env, raid, 1); };

/** Raiders land, take 40 points from cache c1 and deliver it. */
export function simpleRaidWin(env, raid) {
  joinAll(env, raid, ['s1', 's2', 's3', 'v1', 'v2', 'v3']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const c = raid.caches[0];
  goto(env, raid, 'v1', c.x, c.y);
  for (let i = 0; i < 4; i++) raid.enqueue('v1', { t: 'pickup_loot', cache: c.id });
  run(env, raid, 2);
  goto(env, raid, 'v1', 20.5, 45.5, 1);
  raid.enqueue('v1', { t: 'deliver' });
  run(env, raid, 2);
}

import { Raid } from './raid.js';
import { nullLog } from './eventlog.js';

function build(log, raidId, cfg, { shiftMs = 0 } = {}) {
  const events = log.query({ raidId });
  const start = events.find((e) => e.type === 'raid_start');
  if (!start) return null;
  const setup = structuredClone(start.data.setup);
  setup.startMs += shiftMs;
  setup.endMs += shiftMs;
  const raid = new Raid(setup, cfg, { log: nullLog });
  return { raid, events, inputs: events.filter((e) => e.type === 'input'), end: events.find((e) => e.type === 'raid_end') };
}

function feed(raid, inputs, lastTick) {
  let i = 0;
  while (!raid.finished && raid.tick <= lastTick + 1) {
    while (i < inputs.length && inputs[i].tick === raid.tick) {
      const { accountId, intent } = inputs[i].data;
      raid.enqueue(accountId, intent, intent.t.startsWith('sys_'));
      i++;
    }
    raid.step();
  }
}

/**
 * Rebuild a raid from the event log and check it ends in the same state.
 * Only accepted inputs are replayed; rejected inputs never changed state.
 */
export function replayRaid(log, raidId, cfg) {
  const b = build(log, raidId, cfg);
  if (!b) return { ok: false, reason: 'no_raid_start' };
  const { raid, inputs, end } = b;
  feed(raid, inputs, end ? end.tick : Math.max(0, ...inputs.map((e) => e.tick)));
  if (!end) return { ok: true, finished: raid.finished, hash: raid.stateHash(), score: raid.score, ticks: raid.tick };
  const ok = raid.finished && raid.result.stateHash === end.data.stateHash;
  return { ok, hash: raid.result?.stateHash, expected: end.data.stateHash, score: raid.score, winner: raid.result?.winner, ticks: raid.tick };
}

/**
 * Rebuild a raid that was still running when the server stopped. It is replayed up
 * to its last logged input, then attached to the live log and hooks to carry on.
 */
export function resumeRaid(log, raidId, cfg, { hooks = {}, shiftMs = 0 } = {}) {
  const b = build(log, raidId, cfg, { shiftMs });
  if (!b || b.end) return null;
  const { raid, inputs } = b;
  feed(raid, inputs, Math.max(0, ...inputs.map((e) => e.tick)));
  raid.log = log;
  raid.hooks = hooks;
  return raid;
}

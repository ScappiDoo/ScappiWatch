import { Raid } from './raid.js';
import { nullLog } from './eventlog.js';

/**
 * Rebuild a raid from the event log and check it ends in the same state.
 * Only accepted inputs are replayed; rejected inputs never changed state.
 */
export function replayRaid(log, raidId, cfg) {
  const events = log.query({ raidId });
  const start = events.find((e) => e.type === 'raid_start');
  const end = events.find((e) => e.type === 'raid_end');
  if (!start) return { ok: false, reason: 'no_raid_start' };
  const raid = new Raid(structuredClone(start.data.setup), cfg, { log: nullLog });
  const inputs = events.filter((e) => e.type === 'input');
  const lastTick = end ? end.tick : Math.max(0, ...inputs.map((e) => e.tick));
  let i = 0;
  while (!raid.finished && raid.tick <= lastTick + 1) {
    while (i < inputs.length && inputs[i].tick === raid.tick) {
      const { accountId, intent } = inputs[i].data;
      raid.enqueue(accountId, intent, intent.t.startsWith('sys_'));
      i++;
    }
    raid.step();
  }
  if (!end) return { ok: true, finished: raid.finished, hash: raid.stateHash(), score: raid.score, ticks: raid.tick };
  const ok = raid.finished && raid.result.stateHash === end.data.stateHash;
  return { ok, hash: raid.result?.stateHash, expected: end.data.stateHash, score: raid.score, winner: raid.result?.winner, ticks: raid.tick };
}

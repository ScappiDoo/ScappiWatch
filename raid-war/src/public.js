// What the spectator page may see. Only these event types leave the server,
// and only these fields: no IPs, devices, tickets or anti-cheat data.
const PUBLIC = new Set(['war_declared', 'raid_start', 'camp_placed', 'loot_picked_up', 'loot_dropped', 'loot_delivered',
  'loot_recovered', 'defeat', 'raid_end', 'raid_cancelled', 'no_show', 'land_change', 'war_ended', 'tribute_paid', 'surrender']);

export function publicEvents(log, { sinceSeq = 0, limit = 100 } = {}) {
  return log.events.filter((e) => e.seq > sinceSeq && PUBLIC.has(e.type)).slice(-limit).map((e) => ({
    seq: e.seq, ts: e.ts, type: e.type, warId: e.warId, raidId: e.raidId,
    data: e.type === 'raid_start' ? { endMs: e.data.setup.endMs } : e.type === 'defeat' ? { attacker: e.data.attacker, victim: e.data.victim, cause: e.data.cause } : stripSecrets(e.data),
  }));
}

const stripSecrets = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => !['setup', 'evidence', 'ip', 'device'].includes(k)));

export function publicState(wm) {
  const raids = [...wm.raids.values()].filter((r) => !r.finished).map((r) => r.publicView());
  const wars = [...wm.wars.values()].map((w) => ({
    id: w.id, attackerId: w.attackerId, defenderId: w.defenderId, status: w.status, reason: w.reason, wins: w.wins,
    goalTiles: w.goalTiles, nextRaid: w.slot ? { startMs: w.slot.startMs, endMs: w.slot.endMs } : null,
  }));
  return { now: wm.clock(), timezone: wm.cfg.timezone, wars, raids };
}

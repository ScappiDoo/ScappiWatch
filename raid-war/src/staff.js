import { DAY, HOUR } from './time.js';

/**
 * Staff tools. They only touch war state (pause, end, score back, undo). There is
 * no inventory or treasury access here, so they cannot duplicate items, and
 * there is no log editing at all. Every call is itself logged.
 */
export class Staff {
  constructor({ manager, isStaff = () => true, clock = Date.now }) {
    this.m = manager;
    this.isStaff = isStaff;
    this.clock = clock;
    this.undoProposals = new Map();
  }

  guard(staffId, action, warId) {
    if (!this.isStaff(staffId)) {
      this.m.emit('staff_denied', { warId, actor: staffId, data: { action } });
      return false;
    }
    return true;
  }

  pause(warId, staffId, reason, now = this.clock()) {
    const war = this.m.wars.get(warId);
    if (!war || war.status !== 'active' || !this.guard(staffId, 'pause', warId)) return { ok: false };
    war.status = 'paused';
    war.pausedAt = now;
    this.m.emit('staff_pause', { warId, actor: staffId, data: { reason } });
    return { ok: true };
  }

  resume(warId, staffId, now = this.clock()) {
    const war = this.m.wars.get(warId);
    if (!war || war.status !== 'paused' || !this.guard(staffId, 'resume', warId)) return { ok: false };
    const paused = now - war.pausedAt;
    war.status = 'active';
    war.pausedAt = null;
    // Everything on the war's clock moves later by the time it was paused.
    war.firstRaidAt += paused;
    if (war.slot) { war.slot.startMs += paused; war.slot.endMs += paused; war.slot.lockAt += paused; }
    const raid = war.raidId && this.m.raids.get(war.raidId);
    if (raid) { raid.setup.startMs += paused; raid.setup.endMs += paused; }
    this.m.emit('staff_resume', { warId, actor: staffId, data: { pausedMs: paused } });
    return { ok: true };
  }

  end(warId, staffId, reason, now = this.clock()) {
    const war = this.m.wars.get(warId);
    if (!war || war.status === 'ended' || !this.guard(staffId, 'end', warId)) return { ok: false };
    this.m.emit('staff_end', { warId, actor: staffId, data: { reason } });
    this.m.endWar(war, { outcome: 'none', reason: 'staff', byStaff: staffId }, now);
    return { ok: true };
  }

  /** Set a live score back. Scores can only be lowered, never raised, by staff. */
  scoreBack(warId, staffId, side, points, reason) {
    const war = this.m.wars.get(warId);
    const raid = war?.raidId && this.m.raids.get(war.raidId);
    if (!raid || !this.guard(staffId, 'score_back', warId)) return { ok: false, reason: 'no_live_raid' };
    this.m.emit('staff_score_back', { warId, raidId: raid.setup.raidId, actor: staffId, data: { side, points, reason } });
    raid.enqueue(null, { t: 'sys_score_back', side, points }, true);
    return { ok: true };
  }

  /** Undoing a finished war needs two different staff members. */
  undo(warId, staffId, reason, now = this.clock()) {
    const war = this.m.wars.get(warId);
    if (!war || war.status !== 'ended' || war.result?.undo || !this.guard(staffId, 'undo', warId)) return { ok: false, reason: 'cannot_undo' };
    const prop = this.undoProposals.get(warId);
    if (!prop) {
      this.undoProposals.set(warId, { by: staffId, reason });
      this.m.emit('staff_undo_proposed', { warId, actor: staffId, data: { reason } });
      return { ok: true, status: 'needs_second_staff' };
    }
    if (prop.by === staffId) return { ok: false, reason: 'second_staff_must_differ' };
    const w = this.m.world;
    const r = war.result;
    if (r.outcome === 'attacker' && r.landMoved.length) {
      const back = r.landMoved.filter((k) => w.nation(war.attackerId).tiles.has(k));
      w.transferTiles(war.attackerId, war.defenderId, back, now);
      w.landGrace.pop(); // handing land back is not a loss, so no grace entry
    }
    const A = w.nation(war.attackerId), D = w.nation(war.defenderId);
    A.protectedUntil = D.protectedUntil = 0;
    A.declareCooldownUntil = 0;
    w.pairBlocks = w.pairBlocks.filter((b) => !((b.from === A.id && b.to === D.id) || (b.from === D.id && b.to === A.id)));
    r.undo = { by: [prop.by, staffId], at: now, reason };
    this.undoProposals.delete(warId);
    this.m.emit('war_result_undone', { warId, actor: staffId, data: { proposedBy: prop.by, approvedBy: staffId, reason: prop.reason, raidIds: war.raids.map((x) => x.raidId) } });
    return { ok: true, status: 'undone' };
  }

  // ---- disputes -------------------------------------------------------------------------

  openTicket({ accountId, raidId, text }, now = this.clock()) {
    const raid = this.m.raids.get(raidId);
    const end = raid && this.m.log.query({ raidId, type: 'raid_end' })[0];
    if (!raid || !end) return { ok: false, reason: 'raid_not_finished' };
    if (now - end.ts > this.m.cfg.retention.disputeHours * HOUR) return { ok: false, reason: 'dispute_window_closed' };
    const t = { id: `T${this.m.tickets.length + 1}`, accountId, raidId, text, status: 'open', openedAt: now };
    this.m.tickets.push(t);
    this.m.emit('dispute_opened', { raidId, warId: raid.setup.warId, actor: accountId, data: { ticket: t.id, text } });
    return { ok: true, ticket: t.id };
  }

  resolveTicket(ticketId, staffId, decision) {
    const t = this.m.tickets.find((x) => x.id === ticketId);
    if (!t || t.status !== 'open' || !this.guard(staffId, 'resolve_ticket', null)) return { ok: false };
    t.status = 'resolved';
    this.m.emit('dispute_resolved', { raidId: t.raidId, actor: staffId, data: { ticket: t.id, decision } });
    return { ok: true };
  }
}

export { DAY };

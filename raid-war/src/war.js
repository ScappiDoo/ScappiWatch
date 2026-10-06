import { Raid } from './raid.js';
import { validateGoal, validateShrink } from './land.js';
import { connected, parseTile, tk, NEIGHBORS } from './world.js';
import { DAY, HOUR, addDays, dateKey, nextWindow, windowsOn } from './time.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const other = (side) => (side === 'attacker' ? 'defender' : 'attacker');

/** Who is online and when they last did something. One connection per account. */
export class Presence {
  constructor() { this.m = new Map(); }
  connect(id, now, connId = id) {
    if (this.m.has(id)) return false;
    this.m.set(id, { connId, connectedAt: now, lastInputAt: now });
    return true;
  }
  disconnect(id) { this.m.delete(id); }
  touch(id, now) { const p = this.m.get(id); if (p) p.lastInputAt = now; }
  get(id) { return this.m.get(id); }
}

/**
 * Owns wars: declaration, validation, scheduling, raid lifecycle, and results.
 * The only entry points that change a war are methods on this class, and every
 * one of them writes to the event log.
 */
export class WarManager {
  constructor({ world, log, cfg, clock = Date.now, hooks = {}, presence = new Presence() }) {
    this.world = world;
    this.log = log;
    this.cfg = cfg;
    this.clock = clock;
    this.hooks = hooks; // lockStorage(nationId, bool), wear(accountId, pct), charge(accountId, amount), notify(kind, payload), rejected, hitCheck, input
    this.presence = presence;
    this.wars = new Map();
    this.raids = new Map(); // raidId -> Raid (kept for results; finished ones too)
    this.bookings = new Map(); // `${targetId}|${dayKey}` -> raids booked or run that day
    this.tickets = [];
    this.seq = 0;
  }

  emit(type, { warId = null, raidId = null, actor = 'system', data = {} } = {}) {
    this.log.append(type, { warId, raidId, actor, data });
    this.hooks.notify?.(type, { warId, raidId, ...data });
  }

  // ---- queries ------------------------------------------------------------------

  activeWarsOf(nationId) {
    return [...this.wars.values()].filter((w) => w.status !== 'ended' && (w.attackerId === nationId || w.defenderId === nationId));
  }

  isAtWar(nationId) { return this.activeWarsOf(nationId).length > 0; }

  /** No joining or leaving a nation during a war. */
  canChangeMembership(nationId) { return !this.isAtWar(nationId); }

  rosterNations(war, side) {
    return [side === 'attacker' ? war.attackerId : war.defenderId, ...war.allies[side]];
  }

  raidFor(accountId) {
    for (const war of this.wars.values()) {
      const raid = war.raidId && this.raids.get(war.raidId);
      if (raid && !raid.finished && raid.players.has(accountId)) return raid;
    }
    return null;
  }

  // ---- declaration ----------------------------------------------------------------

  declare({ attackerId, targetId, byAccount, reason, goalTiles }, now = this.clock()) {
    const w = this.world, c = this.cfg;
    const reject = (why) => {
      this.emit('declaration_rejected', { actor: byAccount, data: { attackerId, targetId, reason: why } });
      return { ok: false, reason: why };
    };
    if (attackerId === targetId) return reject('same_nation');
    if (!w.nations.has(attackerId) || !w.nations.has(targetId)) return reject('unknown_nation');
    const A = w.nation(attackerId), T = w.nation(targetId);
    if (!w.can(attackerId, byAccount, 'declare')) return reject('no_declare_permission');
    if (!String(reason || '').trim()) return reject('reason_required');
    if (w.isShielded(attackerId, now) || w.isShielded(targetId, now)) return reject('vacation_shield');
    if (w.isProtected(targetId, now)) return reject('target_protected');
    if (now - A.createdAt < c.war.newNationProtectionHours * HOUR) return reject('attacker_too_new');
    if (A.declareCooldownUntil > now) return reject('attacker_cooldown');
    if (w.pairBlocked(attackerId, targetId, now)) return reject('pair_protected');
    if (this.activeWarsOf(attackerId).length >= c.war.maxActiveWars) return reject('attacker_max_wars');
    if (this.activeWarsOf(targetId).length >= c.war.maxActiveWars) return reject('target_max_wars');
    if (this.activeWarsOf(attackerId).some((x) => x.attackerId === attackerId && x.defenderId === targetId)) return reject('already_at_war');
    if (w.areAllied(attackerId, targetId)) return reject('allied');
    if (w.sharesMembers(attackerId, targetId)) return reject('shared_members');
    const v = validateGoal(goalTiles, A, T, c);
    if (!v.ok) return reject(v.reason);

    const id = `W${++this.seq}`;
    const war = {
      id, attackerId, defenderId: targetId, reason: String(reason).slice(0, 500), goalTiles: [...goalTiles],
      declaredAt: now, firstRaidAt: now + c.war.noticeHours * HOUR, homeWindow: T.homeWindow,
      status: 'active', allies: { attacker: [], defender: [] }, wins: { attacker: 0, defender: 0 },
      noShows: { attacker: 0, defender: 0 }, raids: [], slot: null, raidId: null, lastRaidDay: null,
      pending: { tribute: null, peace: null }, pausedAt: null, result: null, heldHorses: [],
    };
    this.wars.set(id, war);
    this.schedule(war, now);
    this.emit('war_declared', {
      warId: id, actor: byAccount,
      data: { attackerId, targetId, reason: war.reason, goalTiles: war.goalTiles, noticeAt: now, firstRaidAt: war.slot.startMs, homeWindow: war.homeWindow },
    });
    return { ok: true, warId: id, firstRaidAt: war.slot.startMs };
  }

  /** The war goal can be made smaller after declaration, never larger. */
  shrinkGoal(warId, byAccount, newGoal) {
    const war = this.wars.get(warId);
    if (!war || war.status === 'ended') return { ok: false, reason: 'no_such_war' };
    if (!this.world.can(war.attackerId, byAccount, 'declare')) return { ok: false, reason: 'no_permission' };
    if (war.raidId) return { ok: false, reason: 'raid_running' };
    const v = validateShrink(war.goalTiles, newGoal);
    if (!v.ok) return v;
    war.goalTiles = [...newGoal];
    this.emit('war_goal_shrunk', { warId, actor: byAccount, data: { goalTiles: newGoal } });
    return { ok: true };
  }

  addAlly(warId, side, nationId, byAccount) {
    const war = this.wars.get(warId);
    if (!war || war.status === 'ended') return { ok: false, reason: 'no_such_war' };
    const main = side === 'attacker' ? war.attackerId : war.defenderId;
    const w = this.world;
    const fail = (reason) => ({ ok: false, reason });
    if (!w.can(main, byAccount, 'declare')) return fail('no_permission');
    if (war.raidId) return fail('raid_running');
    if (war.allies[side].length >= this.cfg.war.maxAlliesPerSide) return fail('ally_cap');
    if (!w.areAllied(main, nationId)) return fail('not_allied');
    if ([war.attackerId, war.defenderId].includes(nationId) || w.areAllied(nationId, side === 'attacker' ? war.defenderId : war.attackerId)) return fail('ally_conflict');
    war.allies[side].push(nationId);
    this.emit('ally_joined', { warId, actor: byAccount, data: { side, nationId } });
    return { ok: true };
  }

  // ---- scheduling -----------------------------------------------------------------

  /** Next slot: target's home window, >= notice time, one raid per war per day, one per target per day. */
  schedule(war, now) {
    const T = this.world.nation(war.defenderId);
    let from = Math.max(war.firstRaidAt, now);
    if (war.lastRaidDay) from = Math.max(from, windowsOn(addDays(war.lastRaidDay, 1), this.cfg)[0].startMs - 1);
    for (let i = 0; i < 60; i++) {
      const win = nextWindow(from, war.homeWindow, this.cfg);
      const key = `${T.id}|${win.day}`;
      if ((this.bookings.get(key) || 0) < this.cfg.war.maxRaidsPerTargetPerDay && win.day !== war.lastRaidDay) {
        this.bookings.set(key, (this.bookings.get(key) || 0) + 1);
        war.slot = { ...win, lockAt: win.startMs - this.cfg.caches.lockMinutesBeforeWindow * 60000, locked: false, bookingKey: key };
        return war.slot;
      }
      from = win.endMs;
    }
    throw new Error('could not schedule a raid');
  }

  /** Give back a reserved slot that never ran (war ended first). A slot that ran or was cancelled keeps its day. */
  unbook(war) {
    if (war.slot) this.bookings.set(war.slot.bookingKey, Math.max(0, (this.bookings.get(war.slot.bookingKey) || 1) - 1));
    war.slot = null;
  }

  // ---- the clock ------------------------------------------------------------------

  tick(now = this.clock()) {
    for (const war of this.wars.values()) {
      if (war.status !== 'active') continue;
      if (now - war.declaredAt > this.cfg.war.expireAfterDays * DAY && !war.raidId) {
        this.endWar(war, { outcome: 'none', reason: 'expired' }, now);
        continue;
      }
      const raid = war.raidId && this.raids.get(war.raidId);
      if (raid) {
        raid.advanceTo(now);
        if (raid.finished) this.finalizeRaid(war, raid, now);
        continue;
      }
      const s = war.slot;
      if (!s) continue;
      if (!s.locked && now >= s.lockAt) {
        s.locked = true;
        this.hooks.lockStorage?.(war.defenderId, true);
        this.emit('caches_locked', { warId: war.id, data: { nationId: war.defenderId, until: s.endMs } });
      }
      if (now >= s.startMs) {
        if (now >= s.endMs) this.cancelRaid(war, 'window_missed', now);
        else this.beginRaid(war, now);
      }
    }
  }

  eligible(war, side, windowStart, now) {
    const out = [];
    for (const nid of this.rosterNations(war, side)) {
      for (const [id, m] of this.world.nation(nid).members) {
        const pr = this.presence.get(id);
        if (!m.verified) continue;
        if (windowStart - m.joinedAt < this.cfg.war.eligibleMemberAgeDays * DAY) continue;
        if (!pr || pr.connectedAt >= windowStart) continue; // must be connected before the window began
        if (now - pr.lastInputAt > this.cfg.war.idleSeconds * 1000) continue; // idle
        out.push({ id, side, nationId: nid, weapon: m.weapon });
      }
    }
    return out;
  }

  cancelRaid(war, why, now, { noShow = null } = {}) {
    const s = war.slot;
    this.emit('raid_cancelled', { warId: war.id, data: { reason: why, window: s?.index, day: s?.day, noShow } });
    war.lastRaidDay = s?.day ?? war.lastRaidDay;
    this.hooks.lockStorage?.(war.defenderId, false);
    war.slot = null; // the day stays booked even though the raid did not run
    this.schedule(war, now);
  }

  beginRaid(war, now) {
    const s = war.slot;
    const att = this.eligible(war, 'attacker', s.startMs, now);
    const def = this.eligible(war, 'defender', s.startMs, now);
    const min = this.cfg.war;
    const defOk = def.length >= min.minDefenders, attOk = att.length >= min.minRaiders;
    this.emit('raid_start_check', { warId: war.id, data: { raiders: att.length, defenders: def.length, window: s.index } });
    if (!defOk && !attOk) return this.cancelRaid(war, 'both_below_minimum', now);
    if (!defOk) {
      war.noShows.defender++;
      this.emit('no_show', { warId: war.id, data: { side: 'defender', count: war.noShows.defender, eligible: def.length } });
      if (war.noShows.defender >= min.defenderNoShowsToForfeit) {
        this.cancelRaid(war, 'defender_no_show', now, { noShow: 'defender' });
        return this.endWar(war, { outcome: 'attacker', reason: 'forfeit' }, now);
      }
      return this.cancelRaid(war, 'defender_no_show', now, { noShow: 'defender' });
    }
    if (!attOk) {
      war.noShows.attacker++;
      this.world.nation(war.attackerId).declareCooldownUntil = now + min.raiderNoShowCooldownHours * HOUR;
      this.emit('no_show', { warId: war.id, data: { side: 'attacker', count: war.noShows.attacker, eligible: att.length } });
      return this.cancelRaid(war, 'raider_no_show', now, { noShow: 'attacker' });
    }
    const setup = this.buildSetup(war, s, [...att, ...def]);
    const raidId = `R${war.id.slice(1)}-${war.raids.length + 1}`;
    setup.raidId = raidId;
    const raid = new Raid(setup, this.cfg, { log: this.log, hooks: this.hooks });
    this.raids.set(raidId, raid);
    war.raidId = raidId;
    this.emit('raid_start', { warId: war.id, raidId, data: { setup } });
    for (const r of setup.roster) raid.enqueue(r.id, { t: 'sys_connect' }, true);
    this.hooks.notify?.('raid_horn', { warId: war.id, raidId, kind: 'start' });
    raid.advanceTo(now);
  }

  /** Zone, caches, spawns and the like, from the territory as it is when the raid starts. */
  buildSetup(war, slot, roster) {
    const w = this.world, strip = this.cfg.zone.borderStrip;
    const T = w.nation(war.defenderId);
    const zone = new Set();
    for (const k of war.goalTiles) {
      const [x, y] = parseTile(k);
      for (let dx = -strip; dx <= strip; dx++) for (let dy = -strip; dy <= strip; dy++) zone.add(tk(x + dx, y + dy));
    }
    const caches = this.placeCaches(T, zone);
    const forbidden = new Set();
    const xs = [...zone].map((k) => parseTile(k));
    const margin = this.cfg.camp.minDistFromCache + 8;
    const minX = Math.min(...xs.map((p) => p[0])) - margin, maxX = Math.max(...xs.map((p) => p[0])) + margin;
    const minY = Math.min(...xs.map((p) => p[1])) - margin, maxY = Math.max(...xs.map((p) => p[1])) + margin;
    for (const [k, owner] of w.owner) {
      const [x, y] = parseTile(k);
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (owner !== war.attackerId) forbidden.add(k); // target land and third-party land
    }
    const livestock = [], horses = [];
    const t = [...T.tiles].filter((k) => zone.has(k)).sort();
    t.slice(0, this.cfg.livestock.perRaid).forEach((k, i) => { const [x, y] = parseTile(k); livestock.push({ id: `a${i + 1}`, x: x + 0.5, y: y + 0.5 }); });
    t.slice(-this.cfg.horses.perRaid).forEach((k, i) => { const [x, y] = parseTile(k); horses.push({ id: `h${i + 1}`, x: x + 0.5, y: y + 0.5, ownerId: [...T.members.keys()][i % T.members.size] }); });
    return {
      warId: war.id, attackerId: war.attackerId, defenderId: war.defenderId, startMs: slot.startMs, endMs: slot.endMs,
      bounds: { w: w.width, h: w.height }, goalTiles: war.goalTiles, zoneTiles: [...zone].sort(),
      blocked: [...w.blocked].sort(), forbiddenCamp: [...forbidden].sort(), caches, spawns: T.spawns,
      livestock, horses, roster,
    };
  }

  /** 3 caches as far apart as the territory allows, at least `minSpacing` apart when it allows. */
  placeCaches(T, zone) {
    const cands = [...T.tiles].filter((k) => zone.has(k)).sort().map((k) => { const [x, y] = parseTile(k); return { x: x + 0.5, y: y + 0.5 }; });
    const n = this.cfg.caches.count;
    const chosen = [cands[0]];
    while (chosen.length < Math.min(n, cands.length)) {
      let best = null, bestD = -1;
      for (const c of cands) {
        const d = Math.min(...chosen.map((q) => dist(c, q)));
        if (d > bestD) { bestD = d; best = c; }
      }
      chosen.push(best);
    }
    const spacing = Math.min(...chosen.flatMap((a, i) => chosen.slice(i + 1).map((b) => dist(a, b))), Infinity);
    if (spacing < this.cfg.caches.minSpacing) this.emit('config_warning', { data: { reason: 'caches_closer_than_min_spacing', spacing, nationId: T.id } });
    return chosen.map((c, i) => ({ id: `c${i + 1}`, ...c }));
  }

  joinRaid(accountId, now = this.clock()) {
    const raid = [...this.raids.values()].find((r) => !r.finished && r.players.has(accountId));
    if (!raid) return { ok: false, reason: 'no_raid' };
    this.presence.touch(accountId, now);
    raid.enqueue(accountId, { t: 'join' });
    return { ok: true, raidId: raid.setup.raidId };
  }

  // ---- end of a raid and of a war ---------------------------------------------------

  finalizeRaid(war, raid, now) {
    const res = raid.result;
    war.raids.push({ raidId: raid.setup.raidId, winner: res.winner, score: res.score, day: war.slot.day });
    war.wins[res.winner]++;
    war.heldHorses.push(...res.heldHorses);
    war.lastRaidDay = war.slot.day;
    war.raidId = null;
    this.hooks.lockStorage?.(war.defenderId, false);
    war.slot = null; // that day is spent
    this.emit('raid_result', { warId: war.id, raidId: raid.setup.raidId, data: { winner: res.winner, score: res.score, wins: war.wins } });
    this.hooks.notify?.('raid_horn', { warId: war.id, raidId: raid.setup.raidId, kind: 'end' });
    if (war.wins.attacker >= this.cfg.war.raidsToWin) return this.endWar(war, { outcome: 'attacker', reason: 'raids_won' }, now);
    if (war.wins.defender >= this.cfg.war.raidsToWin) return this.endWar(war, { outcome: 'defender', reason: 'raids_won' }, now);
    if (war.status === 'active') this.schedule(war, now);
  }

  /**
   * outcome: 'attacker' (land changes hands), 'defender' (attacker loses), or
   * 'none' (tribute, peace, staff end, expiry: nothing changes hands).
   */
  endWar(war, { outcome, reason, byStaff = null, pairProtectDays = 0 }, now = this.clock()) {
    if (war.status === 'ended') return;
    const raid = war.raidId && this.raids.get(war.raidId);
    if (raid && !raid.finished) { raid.enqueue(null, { t: 'sys_abort', reason: `war_ended:${reason}` }, true); raid.step(); }
    this.hooks.lockStorage?.(war.defenderId, false);
    if (raid) war.slot = null; // a raid that ran keeps its day
    else this.unbook(war);
    war.raidId = null;
    war.status = 'ended';
    const w = this.world, c = this.cfg;
    const A = w.nation(war.attackerId), D = w.nation(war.defenderId);
    const result = { outcome, reason, endedAt: now, landMoved: [], undo: null };
    if (outcome === 'attacker') {
      const goal = war.goalTiles.filter((k) => D.tiles.has(k));
      w.transferTiles(D.id, A.id, goal, now);
      result.landMoved = goal;
      D.protectedUntil = now + c.protection.afterLostWarDays * DAY;
      w.pairBlocks.push({ from: A.id, to: D.id, until: now + c.protection.afterLostWarDays * DAY, reason: 'war_won' });
      this.emit('land_change', { warId: war.id, data: { from: D.id, to: A.id, tiles: goal, graceUntil: now + c.land.graceHours * HOUR } });
      for (const h of war.heldHorses) this.emit('horse_buyback_offer', { warId: war.id, data: { ...h, price: c.horses.buybackPrice } });
    } else if (outcome === 'defender') {
      A.protectedUntil = now + c.protection.afterLostWarDays * DAY;
      A.declareCooldownUntil = Math.max(A.declareCooldownUntil, now + c.protection.attackerLossCooldownDays * DAY);
      w.pairBlocks.push({ from: D.id, to: A.id, until: now + c.protection.afterLostWarDays * DAY, reason: 'war_lost' });
      for (const h of war.heldHorses) this.emit('horse_returned', { warId: war.id, data: { ...h, withGear: true, reason: 'raiders_lost' } });
    } else {
      for (const h of war.heldHorses) this.emit('horse_returned', { warId: war.id, data: { ...h, withGear: true, reason: `war_ended_${reason}` } });
    }
    if (pairProtectDays) w.pairBlocks.push({ from: A.id, to: D.id, until: now + pairProtectDays * DAY, reason: 'tribute' });
    war.result = result;
    this.emit('war_ended', { warId: war.id, actor: byStaff || 'system', data: { ...result, wins: war.wins } });
  }

  // ---- surrender, peace, tribute --------------------------------------------------------

  surrender(warId, side, byAccount, now = this.clock()) {
    const war = this.wars.get(warId);
    if (!war || war.status === 'ended') return { ok: false, reason: 'no_such_war' };
    const nid = side === 'attacker' ? war.attackerId : war.defenderId;
    if (!this.world.can(nid, byAccount, 'surrender')) return { ok: false, reason: 'no_permission' };
    this.emit('surrender', { warId, actor: byAccount, data: { side } });
    // Defender surrender hands over the war goal at once; attacker surrender gives nothing and starts the cooldown.
    this.endWar(war, { outcome: side === 'defender' ? 'attacker' : 'defender', reason: `${side}_surrender` }, now);
    return { ok: true };
  }

  proposePeace(warId, side, byAccount) {
    const war = this.wars.get(warId);
    if (!war || war.status === 'ended') return { ok: false, reason: 'no_such_war' };
    const nid = side === 'attacker' ? war.attackerId : war.defenderId;
    if (!this.world.can(nid, byAccount, 'peace')) return { ok: false, reason: 'no_permission' };
    if (war.pending.peace && war.pending.peace !== side) {
      this.emit('peace_signed', { warId, actor: byAccount, data: {} });
      this.endWar(war, { outcome: 'none', reason: 'peace' });
      return { ok: true, signed: true };
    }
    war.pending.peace = side;
    this.emit('peace_proposed', { warId, actor: byAccount, data: { side } });
    return { ok: true, signed: false };
  }

  offerTribute(warId, byAccount, amount) {
    const war = this.wars.get(warId);
    if (!this.cfg.tribute.enabled) return { ok: false, reason: 'tribute_disabled' };
    if (!war || war.status === 'ended') return { ok: false, reason: 'no_such_war' };
    if (!this.world.can(war.defenderId, byAccount, 'tribute')) return { ok: false, reason: 'no_permission' };
    const cap = Math.floor((this.world.nation(war.defenderId).treasury * this.cfg.tribute.maxTreasuryPct) / 100);
    if (!(amount > 0) || amount > cap) return { ok: false, reason: 'over_tribute_cap', cap };
    war.pending.tribute = { amount, by: byAccount };
    this.emit('tribute_offered', { warId, actor: byAccount, data: { amount, cap } });
    return { ok: true };
  }

  answerTribute(warId, byAccount, accept, now = this.clock()) {
    const war = this.wars.get(warId);
    if (!war || war.status === 'ended' || !war.pending.tribute) return { ok: false, reason: 'no_offer' };
    if (!this.world.can(war.attackerId, byAccount, 'tribute')) return { ok: false, reason: 'no_permission' };
    const { amount } = war.pending.tribute;
    war.pending.tribute = null;
    if (!accept) { this.emit('tribute_refused', { warId, actor: byAccount, data: { amount } }); return { ok: true, accepted: false }; }
    const D = this.world.nation(war.defenderId), A = this.world.nation(war.attackerId);
    if (D.treasury < amount) return { ok: false, reason: 'insufficient_treasury' };
    const before = { payer: D.treasury, receiver: A.treasury };
    D.treasury -= amount;
    A.treasury += amount;
    this.emit('tribute_paid', { warId, actor: byAccount, data: { amount, payer: D.id, receiver: A.id, before, after: { payer: D.treasury, receiver: A.treasury } } });
    this.endWar(war, { outcome: 'none', reason: 'tribute', pairProtectDays: this.cfg.tribute.protectionDays }, now);
    return { ok: true, accepted: true };
  }

  buyBackHorse(warId, horseId, accountId) {
    const war = this.wars.get(warId);
    const h = war?.heldHorses.find((x) => x.id === horseId);
    if (!h || war.result?.outcome !== 'attacker') return { ok: false, reason: 'not_for_sale' };
    if (h.ownerId !== accountId) return { ok: false, reason: 'not_owner' };
    if (!this.hooks.charge?.(accountId, this.cfg.horses.buybackPrice)) return { ok: false, reason: 'cannot_pay' };
    war.heldHorses = war.heldHorses.filter((x) => x !== h);
    this.emit('horse_bought_back', { warId, actor: accountId, data: { horse: horseId, price: this.cfg.horses.buybackPrice } });
    return { ok: true };
  }

  // ---- membership, home window, shield ------------------------------------------------------

  setHomeWindow(nationId, index, byAccount, now = this.clock()) {
    const r = this.world.setHomeWindow(nationId, index, now, { warActive: this.isAtWar(nationId) });
    this.emit(r.ok ? 'home_window_changed' : 'home_window_rejected', { actor: byAccount, data: { nationId, index, reason: r.reason } });
    return r;
  }

  setShield(nationId, days, byAccount, now = this.clock()) {
    const r = this.world.setShield(nationId, days, now, { warActive: this.isAtWar(nationId) });
    this.emit(r.ok ? 'shield_on' : 'shield_rejected', { actor: byAccount, data: { nationId, days, reason: r.reason } });
    return r;
  }

  leaveNation(nationId, accountId) {
    if (!this.canChangeMembership(nationId)) {
      this.emit('membership_change_rejected', { actor: accountId, data: { nationId, reason: 'war_active' } });
      return { ok: false, reason: 'war_active' };
    }
    this.world.nation(nationId).members.delete(accountId);
    return { ok: true };
  }
}

export { dateKey, connected, NEIGHBORS, other };

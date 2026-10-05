/**
 * Transport-agnostic connection layer. A WebSocket server (or the tests) hands in
 * raw strings; this class runs them through the guard and routes the accepted
 * ones to the right raid. The client only ever sends wishes, never state.
 */
export class Gateway {
  constructor({ wm, guard, detector, clock = Date.now }) {
    Object.assign(this, { wm, guard, detector, clock });
    this.conns = new Map(); // connId -> accountId
  }

  connect(connId, token, meta = {}, now = this.clock()) {
    const r = this.guard.open(connId, token, meta, now);
    if (!r.ok) return r;
    if (!this.wm.presence.connect(r.accountId, now, connId)) {
      this.guard.close(connId);
      return { ok: false, reason: 'second_connection' };
    }
    this.conns.set(connId, r.accountId);
    const raid = this.wm.raidFor(r.accountId);
    if (raid) {
      this.detector.registerSession(raid.setup.raidId, r.accountId, meta);
      raid.enqueue(r.accountId, { t: 'sys_connect' }, true);
    }
    return r;
  }

  disconnect(connId) {
    const id = this.conns.get(connId);
    if (!id) return;
    this.conns.delete(connId);
    this.guard.close(connId);
    this.wm.presence.disconnect(id);
    this.wm.raidFor(id)?.enqueue(id, { t: 'sys_disconnect' }, true);
  }

  message(connId, raw, now = this.clock()) {
    const r = this.guard.handle(connId, raw, now);
    if (!r.ok) return r;
    const { accountId, msg } = r;
    this.wm.presence.touch(accountId, now);
    if (msg.t === 'pong') {
      const ms = this.detector.pong(accountId, msg.nonce, now);
      if (ms === null) return { ok: false, reason: 'bad_pong' };
      this.wm.raidFor(accountId)?.enqueue(accountId, { t: 'sys_ping', ms }, true);
      return { ok: true };
    }
    if (msg.t === 'join') return this.wm.joinRaid(accountId, now);
    const raid = this.wm.raidFor(accountId);
    if (!raid) return { ok: false, reason: 'no_raid' };
    raid.enqueue(accountId, msg);
    return { ok: true };
  }

  /** Called a few times a second: returns the pings the transport should send. */
  pings(now = this.clock()) {
    return [...this.conns].map(([connId, accountId]) => ({ connId, msg: { t: 'ping', nonce: this.detector.newPing(accountId, now) } }));
  }
}

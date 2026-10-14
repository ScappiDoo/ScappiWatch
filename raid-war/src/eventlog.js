import { createHash } from 'node:crypto';

const deepFreeze = (o) => {
  Object.values(o).forEach((v) => v && typeof v === 'object' && !Object.isFrozen(v) && deepFreeze(v));
  return Object.freeze(o);
};

/**
 * Append-only, hash-chained event log. There is no edit or delete API; the
 * only way events leave is retention pruning, which keeps the chain verifiable.
 */
export class EventLog {
  constructor({ clock = Date.now, retentionMs = 30 * 86400000, sink = null } = {}) {
    this.sink = sink; // called with every appended event (the database writer)
    this.clock = clock;
    this.retentionMs = retentionMs;
    this.events = [];
    this.anchor = 'GENESIS';
    this.nextSeq = 1;
    this.listeners = [];
  }

  subscribe(fn) {
    this.listeners.push(fn);
  }

  append(type, { tick = null, warId = null, raidId = null, actor = 'system', data = {} } = {}) {
    const prev = this.events.length ? this.events[this.events.length - 1].hash : this.anchor;
    const ev = { seq: this.nextSeq++, ts: this.clock(), type, tick, warId, raidId, actor, data: structuredClone(data), prev };
    ev.hash = createHash('sha256').update(JSON.stringify(ev)).digest('hex');
    this.events.push(deepFreeze(ev));
    this.sink?.(ev);
    for (const fn of this.listeners) fn(ev);
    return ev;
  }

  /** Load events saved by an earlier run. The chain is checked before anything else runs. */
  restore(events, anchor = 'GENESIS') {
    this.anchor = anchor;
    this.events = events.map((e) => deepFreeze({
      seq: e.seq, ts: e.ts, type: e.type, tick: e.tick, warId: e.warId, raidId: e.raidId, actor: e.actor, data: e.data, prev: e.prev, hash: e.hash,
    }));
    this.nextSeq = this.events.length ? this.events.at(-1).seq + 1 : 1;
    if (!this.verify()) throw new Error('event log failed its hash-chain check: refusing to start on tampered or corrupt data');
  }

  query({ warId, raidId, type, actor } = {}) {
    return this.events.filter((e) =>
      (warId === undefined || e.warId === warId) &&
      (raidId === undefined || e.raidId === raidId) &&
      (type === undefined || e.type === type) &&
      (actor === undefined || e.actor === actor));
  }

  verify() {
    let prev = this.anchor;
    for (const e of this.events) {
      const { hash, ...rest } = e;
      if (rest.prev !== prev) return false;
      if (createHash('sha256').update(JSON.stringify(rest)).digest('hex') !== hash) return false;
      prev = hash;
    }
    return true;
  }

  prune(now = this.clock()) {
    let n = 0, lastSeq = 0;
    while (this.events.length && now - this.events[0].ts > this.retentionMs) {
      const e = this.events.shift();
      this.anchor = e.hash;
      lastSeq = e.seq;
      n++;
    }
    if (n) this.onPrune?.(lastSeq, this.anchor);
    return n;
  }
}

export const nullLog = { append() {}, query: () => [] };

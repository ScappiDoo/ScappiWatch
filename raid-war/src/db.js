import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite storage (built into Node 22, no extra package). Events are queued and
 * written in one transaction every `flushMs`, so the 20 Hz raid loop never waits
 * on the disk. If the process dies, at most that last slice of events is lost.
 */
export class Db {
  constructor(path = ':memory:', { flushMs = 100 } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, tick INTEGER,
        war_id TEXT, raid_id TEXT, actor TEXT, data TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_raid ON events (raid_id);
      CREATE INDEX IF NOT EXISTS events_war ON events (war_id);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.insert = this.db.prepare('INSERT INTO events (seq, ts, type, tick, war_id, raid_id, actor, data, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.queue = [];
    this.pendingKv = new Map();
    this.timer = flushMs > 0 ? setInterval(() => this.flush(), flushMs) : null;
    this.timer?.unref();
  }

  push(ev) {
    this.queue.push(ev);
  }

  /** Queue a key/value write; it lands in the same transaction as the events around it. */
  setKv(key, value) {
    this.pendingKv.set(key, JSON.stringify(value));
  }

  getKv(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  flush() {
    if (!this.queue.length && !this.pendingKv.size) return 0;
    const evs = this.queue, kv = this.pendingKv;
    this.queue = [];
    this.pendingKv = new Map();
    this.db.exec('BEGIN');
    try {
      for (const e of evs) this.insert.run(e.seq, e.ts, e.type, e.tick, e.warId, e.raidId, e.actor, JSON.stringify(e.data), e.prev, e.hash);
      const put = this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of kv) put.run(k, v);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.queue = evs.concat(this.queue); // keep them and retry on the next flush
      for (const [k, v] of kv) if (!this.pendingKv.has(k)) this.pendingKv.set(k, v);
      throw err;
    }
    return evs.length;
  }

  loadEvents() {
    this.flush();
    return this.db.prepare('SELECT * FROM events ORDER BY seq').all().map((r) => ({
      seq: r.seq, ts: r.ts, type: r.type, tick: r.tick, warId: r.war_id, raidId: r.raid_id, actor: r.actor, data: JSON.parse(r.data), prev: r.prev, hash: r.hash,
    }));
  }

  /** Drop events up to `seq` and remember the hash the chain now starts from. */
  prune(seq, anchor) {
    this.flush();
    this.db.prepare('DELETE FROM events WHERE seq <= ?').run(seq);
    this.setKv('anchor', anchor);
    this.flush();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
    this.db.close();
  }
}

// Saves and restores the world and the war manager. Raids are NOT saved as state:
// a running raid is rebuilt from its logged inputs, which is the same replay that
// settles disputes.

export function snapshotWorld(w) {
  return {
    width: w.width, height: w.height, blocked: [...w.blocked], landGrace: w.landGrace, pairBlocks: w.pairBlocks,
    nations: [...w.nations.values()].map((n) => ({
      ...n, tiles: [...n.tiles], members: [...n.members.entries()], allies: [...n.allies],
      homeWindowChangedAt: Number.isFinite(n.homeWindowChangedAt) ? n.homeWindowChangedAt : null,
    })),
  };
}

export function restoreWorld(w, s) {
  w.width = s.width; w.height = s.height;
  w.blocked = new Set(s.blocked);
  w.landGrace = s.landGrace;
  w.pairBlocks = s.pairBlocks;
  w.nations.clear(); w.owner.clear();
  for (const n of s.nations) {
    const nation = { ...n, tiles: new Set(n.tiles), members: new Map(n.members), allies: new Set(n.allies), homeWindowChangedAt: n.homeWindowChangedAt ?? -Infinity };
    w.nations.set(n.id, nation);
    for (const k of nation.tiles) w.owner.set(k, n.id);
  }
}

export function snapshotManager(wm) {
  return { seq: wm.seq, wars: [...wm.wars.values()], bookings: [...wm.bookings], tickets: wm.tickets };
}

export function restoreManager(wm, s) {
  wm.seq = s.seq;
  wm.wars = new Map(s.wars.map((w) => [w.id, w]));
  wm.bookings = new Map(s.bookings);
  wm.tickets = s.tickets;
}

// Events that fire in the middle of a raid many times a second. They never change
// saved state, so they do not trigger a save.
const NOISE = new Set(['input', 'score', 'hit', 'rejected', 'placement', 'placement_expired', 'loot_picked_up', 'loot_dropped',
  'loot_delivered', 'loot_recovered', 'delivery_blocked', 'livestock_taken', 'livestock_returned', 'horse_taken', 'defeat', 'respawn',
  'roster_join', 'roster_leave', 'camp_placed', 'anticheat_flag', 'anticheat_review', 'config_warning']);

/** Keeps the saved state in step with the log, in the same database transaction. */
export class Persistence {
  constructor({ db, log, world, wm }) {
    Object.assign(this, { db, log, world, wm });
    this.dirty = false;
  }

  start() {
    this.log.subscribe((e) => { if (!NOISE.has(e.type)) this.dirty = true; });
    this.log.sink = (ev) => this.db.push(ev);
    this.log.onPrune = (seq, anchor) => this.db.prune(seq, anchor);
  }

  /** Returns true if saved state existed and was loaded. */
  restore() {
    const s = this.db.getKv('state');
    if (!s) return false;
    restoreWorld(this.world, s.world);
    restoreManager(this.wm, s.manager);
    return true;
  }

  save() {
    this.db.setKv('state', { world: snapshotWorld(this.world), manager: snapshotManager(this.wm) });
    this.dirty = false;
  }

  /** Call often: writes only when something changed. */
  flush() {
    if (this.dirty) this.save();
    this.db.flush();
  }
}

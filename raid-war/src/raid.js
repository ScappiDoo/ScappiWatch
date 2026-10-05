import { createHash } from 'node:crypto';
import { nullLog } from './eventlog.js';
import { tk } from './world.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const tileOf = (x, y) => tk(Math.floor(x), Math.floor(y));
const CLIENT_TYPES = new Set([
  'join', 'leave', 'move', 'attack', 'place', 'place_camp', 'pickup_loot', 'recover_loot',
  'deliver', 'claim_horse', 'drive_livestock', 'activity',
]);
const SERVER_TYPES = new Set(['sys_connect', 'sys_disconnect', 'sys_ping', 'sys_score_back', 'sys_abort']);

/**
 * One raid: a deterministic, tick-based simulation. The same setup plus the same
 * ordered list of accepted inputs always gives the same result, which is what
 * makes replays usable as evidence. Nothing in here reads the wall clock or
 * Math.random, and a rejected input never changes state.
 *
 * setup = {
 *   raidId, warId, attackerId, defenderId, startMs, endMs,
 *   bounds:{w,h}, goalTiles:[key], zoneTiles:[key], blocked:[key], forbiddenCamp:[key],
 *   caches:[{id,x,y}], spawns:[{x,y}], livestock:[{id,x,y}], horses:[{id,x,y,ownerId}],
 *   roster:[{id, side:'attacker'|'defender', nationId, weapon}]   // eligible candidates
 * }
 */
export class Raid {
  constructor(setup, cfg, { log = nullLog, hooks = {} } = {}) {
    this.setup = setup;
    this.cfg = cfg;
    this.log = log;
    this.hooks = hooks;
    this.tickMs = cfg.tickMs;
    this.totalTicks = Math.round((setup.endMs - setup.startMs) / this.tickMs);
    this.tick = 0;
    this.finished = false;
    this.result = null;
    this.queue = [];
    this.nextId = 1;

    this.zone = new Set(setup.zoneTiles);
    this.blocked = new Set(setup.blocked);
    this.forbiddenCamp = new Set(setup.forbiddenCamp);
    this.caches = setup.caches.map((c) => ({ ...c, loot: cfg.caches.pointsPerCache, status: 'full' }));
    this.camp = null;
    this.score = { attacker: 0, defender: 0 };
    this.stats = { delivered: 0, recovered: 0, kills: { attacker: 0, defender: 0 }, blocked: 0, animalsClaimed: 0, horsesClaimed: 0 };
    this.drops = [];
    this.placements = [];
    this.animals = setup.livestock.map((a) => ({ ...a, home: { x: a.x, y: a.y }, state: 'home', by: null }));
    this.horses = setup.horses.map((h) => ({ ...h, home: { x: h.x, y: h.y }, state: 'home', by: null }));
    this.spawnCursor = 0;
    this.spawns = this.pickSpawns();

    this.players = new Map();
    for (const r of setup.roster) {
      this.players.set(r.id, {
        id: r.id, side: r.side, nationId: r.nationId, weapon: r.weapon || 'sword',
        state: 'out', x: 0, y: 0, dx: 0, dy: 0, hp: cfg.combat.hp, respawnTick: 0,
        carrying: 0, animals: [], horse: null, connected: true, idle: false,
        lastInputTick: 0, lastCombatTick: -Infinity, lastAttackerId: null,
        attackReadyTick: 0, placeReadyTick: 0, sight: new Map(), blockAwardTick: -Infinity, pingMs: 0, history: [],
      });
    }
  }

  // ---- setup helpers ------------------------------------------------------

  pickSpawns() {
    const min = this.cfg.respawn.defenderMinCacheDistance;
    const ok = this.setup.spawns.filter((s) => this.setup.caches.every((c) => dist(s, c) >= min));
    if (ok.length) return ok;
    // Config problem, not a player problem: fall back to the safest spawns and say so.
    this.emit('config_warning', { reason: 'no_spawn_far_enough_from_caches', min });
    return [...this.setup.spawns].sort((a, b) =>
      Math.min(...this.setup.caches.map((c) => dist(b, c))) - Math.min(...this.setup.caches.map((c) => dist(a, c))));
  }

  emit(type, data = {}, actor = 'system') {
    this.log.append(type, { tick: this.tick, warId: this.setup.warId, raidId: this.setup.raidId, actor, data });
  }

  get startMs() { return this.setup.startMs; }
  inZone(x, y) { return this.zone.has(tileOf(x, y)); }
  flagged(p) { return p.carrying > 0 || p.animals.length > 0 || !!p.horse; }
  side(p) { return p.side; }
  enemies(p) { return [...this.players.values()].filter((q) => q.side !== p.side); }
  inPlay(p) { return p.state === 'alive'; }

  // ---- input --------------------------------------------------------------

  /** Queue an input for the next tick. `fromServer` marks internal sys_* inputs. */
  enqueue(accountId, intent, fromServer = false) {
    this.queue.push({ accountId, intent, fromServer });
  }

  /** Counts that drive the live raider cap. Idle or offline defenders do not count. */
  counts() {
    let raiders = 0, defenders = 0;
    for (const p of this.players.values()) {
      if (p.side === 'defender' && p.connected && !p.idle) defenders++;
      if (p.side === 'attacker' && p.state !== 'out' && p.connected) raiders++;
    }
    return { raiders, defenders };
  }

  reject(accountId, intent, reason) {
    this.emit('rejected', { accountId, type: intent.t, reason }, accountId);
    this.hooks.rejected?.(accountId, reason, this.tick, this);
    return { ok: false, reason };
  }

  accept(accountId, intent) {
    const p = this.players.get(accountId);
    if (p && !intent.t.startsWith('sys_')) { p.lastInputTick = this.tick; p.idle = false; }
    this.emit('input', { accountId, intent }, accountId);
    this.hooks.input?.(accountId, this.tick, intent, this);
    return { ok: true };
  }

  apply(entry) {
    const { accountId, intent, fromServer } = entry;
    if (!intent || typeof intent.t !== 'string') return this.reject(accountId, { t: '?' }, 'bad_intent');
    if (intent.t.startsWith('sys_')) {
      if (!fromServer || !SERVER_TYPES.has(intent.t)) return this.reject(accountId, intent, 'server_only');
    } else if (!CLIENT_TYPES.has(intent.t)) {
      return this.reject(accountId, intent, 'unknown_action');
    }
    const p = this.players.get(accountId);
    if (!p && intent.t !== 'sys_abort' && intent.t !== 'sys_score_back') return this.reject(accountId, intent, 'not_in_roster');
    const fn = this[`on_${intent.t}`];
    return fn.call(this, p, intent, accountId);
  }

  // ---- intent handlers: each validates first and mutates only on success ----

  on_sys_connect(p, i, id) {
    p.connected = true;
    p.idle = false;
    p.lastInputTick = this.tick;
    return this.accept(id, i);
  }

  on_sys_disconnect(p, i, id) {
    this.accept(id, i);
    p.connected = false;
    if (p.state === 'alive' && this.tick - p.lastCombatTick <= (this.cfg.combat.fightSeconds * 1000) / this.tickMs) {
      this.defeat(p, p.lastAttackerId, 'disconnect_in_fight');
    }
    return { ok: true };
  }

  on_sys_ping(p, i, id) {
    p.pingMs = Math.max(0, Math.min(2000, Number(i.ms) || 0));
    return this.accept(id, i);
  }

  on_sys_score_back(_p, i, id) {
    if (!['attacker', 'defender'].includes(i.side) || !(i.points > 0)) return this.reject(id, i, 'bad_adjustment');
    this.score[i.side] = Math.max(0, this.score[i.side] - i.points);
    return this.accept(id, i);
  }

  on_sys_abort(_p, i, id) {
    this.accept(id, i);
    this.finish(i.reason || 'aborted');
    return { ok: true };
  }

  on_activity(p, i, id) {
    p.idle = false;
    return this.accept(id, i);
  }

  on_join(p, i, id) {
    if (p.state !== 'out') return this.reject(id, i, 'already_joined');
    if (!p.connected) return this.reject(id, i, 'not_connected');
    if (p.side === 'attacker') {
      const c = this.counts();
      if (c.raiders + 1 > c.defenders + this.cfg.war.raiderCapOver) return this.reject(id, i, 'raider_cap');
      p.state = this.camp ? 'dead' : 'staged'; // staged raiders land when the camp is placed
      if (this.camp) this.respawnAt(p, 0);
    } else {
      p.state = 'dead';
      this.respawnAt(p, 0);
    }
    this.accept(id, i);
    this.emit('roster_join', { accountId: id, side: p.side });
    return { ok: true };
  }

  on_leave(p, i, id) {
    if (p.state === 'out') return this.reject(id, i, 'not_joined');
    this.accept(id, i);
    if (p.state === 'alive') this.dropEverything(p, null, 'left');
    p.state = 'out';
    p.dx = p.dy = 0;
    this.emit('roster_leave', { accountId: id });
    return { ok: true };
  }

  on_move(p, i, id) {
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    let { dx, dy } = i;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len)) return this.reject(id, i, 'bad_vector');
    if (len > 1) { dx /= len; dy /= len; }
    p.dx = dx;
    p.dy = dy;
    return this.accept(id, i);
  }

  hasLos(a, b) {
    const d = dist(a, b);
    const steps = Math.ceil(d / 0.5);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (this.blocked.has(tileOf(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))) return false;
    }
    return true;
  }

  /** Position of a player `ticks` ticks ago (0 = now). */
  rewound(p, ticks) {
    if (ticks <= 0 || !p.history.length) return { x: p.x, y: p.y };
    return p.history[Math.min(ticks, p.history.length) - 1];
  }

  on_attack(p, i, id) {
    const t = this.players.get(i.target);
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    if (!t || t.side === p.side) return this.reject(id, i, 'bad_target');
    if (!this.inPlay(t)) return this.reject(id, i, 'target_not_in_play');
    if (this.tick < p.attackReadyTick) return this.reject(id, i, 'cooldown');
    const w = this.cfg.combat.weapons[p.weapon];
    const rewindTicks = Math.min(
      Math.ceil(p.pingMs / this.tickMs),
      Math.floor(this.cfg.combat.maxRewindMs / this.tickMs),
    );
    const seen = this.rewound(t, rewindTicks);
    const d = dist(p, seen);
    const inReach = d <= w.range + this.cfg.combat.rangeTolerance;
    this.hooks.hitCheck?.({
      raidId: this.setup.raidId, ms: this.startMs + this.tick * this.tickMs,
      attacker: id, target: t.id, tick: this.tick, dist: d, range: w.range, rewindTicks,
      gross: d > w.range + this.cfg.combat.rangeTolerance + this.cfg.antiCheat.hitGrossMargin, ok: inReach,
    });
    if (!inReach) return this.reject(id, i, 'out_of_range');
    if (!(this.inZone(p.x, p.y) || this.inZone(seen.x, seen.y) || this.flagged(p) || this.flagged(t))) {
      return this.reject(id, i, 'outside_zone');
    }
    if (w.needsLos && !this.hasLos(p, seen)) return this.reject(id, i, 'no_line_of_sight');
    this.accept(id, i);
    const sg = p.sight.get(t.id);
    if (sg && !sg.reported) { // only the first attack after an enemy comes into view measures reaction time
      sg.reported = true;
      this.hooks.reaction?.(id, (this.tick - sg.tick) * this.tickMs, this);
    }
    p.attackReadyTick = this.tick + Math.ceil(w.cooldownMs / this.tickMs);
    p.lastCombatTick = t.lastCombatTick = this.tick;
    t.lastAttackerId = id;
    t.hp -= w.damage;
    this.emit('hit', { attacker: id, victim: t.id, weapon: p.weapon, damage: w.damage, hp: t.hp, x: t.x, y: t.y }, id);
    if (t.hp <= 0) this.defeat(t, id, 'combat', p.weapon);
    return { ok: true };
  }

  on_place(p, i, id) {
    const c = this.cfg.placement;
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    if (!c.kinds.includes(i.kind)) return this.reject(id, i, 'bad_kind');
    if (dist(p, i) > c.range) return this.reject(id, i, 'placement_too_far');
    if (!this.inZone(p.x, p.y)) return this.reject(id, i, 'outside_zone');
    if (this.blocked.has(tileOf(i.x, i.y))) return this.reject(id, i, 'blocked_tile');
    if (!this.hasLos(p, i)) return this.reject(id, i, 'no_line_of_sight');
    if (this.tick < p.placeReadyTick) return this.reject(id, i, 'cooldown');
    if (this.placements.filter((q) => q.by === id).length >= c.maxActive) return this.reject(id, i, 'too_many_placements');
    this.accept(id, i);
    p.placeReadyTick = this.tick + Math.ceil((c.cooldownSeconds * 1000) / this.tickMs);
    const pl = { id: `p${this.nextId++}`, kind: i.kind, x: i.x, y: i.y, by: id, expireTick: this.tick + Math.round((c.lifetimeSeconds * 1000) / this.tickMs) };
    this.placements.push(pl);
    this.emit('placement', { id: pl.id, kind: pl.kind, x: pl.x, y: pl.y }, id);
    return { ok: true };
  }

  on_place_camp(p, i, id) {
    if (p.side !== 'attacker') return this.reject(id, i, 'raiders_only');
    if (p.state === 'out') return this.reject(id, i, 'not_joined');
    if (this.camp) return this.reject(id, i, 'camp_exists');
    const k = tileOf(i.x, i.y);
    if (this.forbiddenCamp.has(k) || this.blocked.has(k)) return this.reject(id, i, 'camp_on_owned_land');
    if (i.x < 0 || i.y < 0 || i.x >= this.setup.bounds.w || i.y >= this.setup.bounds.h) return this.reject(id, i, 'camp_out_of_world');
    const nearest = Math.min(...this.caches.map((c) => dist(i, c)));
    if (nearest < this.cfg.camp.minDistFromCache) return this.reject(id, i, 'camp_too_close_to_cache');
    this.accept(id, i);
    this.camp = { x: i.x, y: i.y, placedBy: id, tick: this.tick };
    this.emit('camp_placed', { x: i.x, y: i.y }, id);
    for (const q of this.players.values()) {
      if (q.side === 'attacker' && q.state === 'staged') { q.state = 'dead'; this.respawnAt(q, 0); }
    }
    return { ok: true };
  }

  near(p, e, range) {
    return dist(p, e) <= range;
  }

  on_pickup_loot(p, i, id) {
    const cache = this.caches.find((c) => c.id === i.cache);
    if (p.side !== 'attacker') return this.reject(id, i, 'raiders_only');
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    if (!cache) return this.reject(id, i, 'bad_cache');
    if (!this.near(p, cache, this.cfg.caches.pickupRange)) return this.reject(id, i, 'too_far');
    if (cache.loot <= 0) return this.reject(id, i, 'cache_empty');
    const room = this.cfg.loot.carryCap - p.carrying;
    if (room <= 0) return this.reject(id, i, 'carry_cap');
    this.accept(id, i);
    const take = Math.min(this.cfg.caches.lootChunk, cache.loot, room);
    cache.loot -= take;
    p.carrying += take;
    cache.status = cache.loot <= 0 ? 'emptied' : 'being_raided';
    cache.takenFrom = true;
    this.emit('loot_picked_up', { accountId: id, cache: cache.id, amount: take, carrying: p.carrying }, id);
    return { ok: true };
  }

  on_recover_loot(p, i, id) {
    const drop = this.drops.find((d) => d.id === i.drop);
    if (p.side !== 'defender') return this.reject(id, i, 'defenders_only');
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    if (!drop) return this.reject(id, i, 'bad_drop');
    if (!this.near(p, drop, this.cfg.caches.recoverRange)) return this.reject(id, i, 'too_far');
    this.accept(id, i);
    this.drops = this.drops.filter((d) => d !== drop);
    const cache = this.caches.find((c) => c.id === drop.cache);
    cache.loot += drop.amount;
    cache.status = cache.loot >= this.cfg.caches.pointsPerCache ? 'full' : 'being_raided';
    this.stats.recovered += drop.amount;
    this.addScore('defender', drop.amount * this.cfg.scoring.lootRecoveredPerPoint, 'loot_recovered', id);
    this.emit('loot_recovered', { accountId: id, drop: drop.id, amount: drop.amount, cache: cache.id }, id);
    return { ok: true };
  }

  on_drive_livestock(p, i, id) {
    const a = this.animals.find((x) => x.id === i.animal);
    if (p.side !== 'attacker') return this.reject(id, i, 'raiders_only');
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    if (!a || a.state !== 'home') return this.reject(id, i, 'bad_animal');
    if (!this.near(p, a, this.cfg.livestock.range)) return this.reject(id, i, 'too_far');
    if (this.stats.animalsClaimed >= this.cfg.livestock.perRaid) return this.reject(id, i, 'livestock_cap');
    this.accept(id, i);
    this.stats.animalsClaimed++;
    a.state = 'driven';
    a.by = id;
    p.animals.push(a.id);
    this.emit('livestock_taken', { accountId: id, animal: a.id }, id);
    return { ok: true };
  }

  on_claim_horse(p, i, id) {
    const h = this.horses.find((x) => x.id === i.horse);
    if (p.side !== 'attacker') return this.reject(id, i, 'raiders_only');
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    if (!h || h.state !== 'home') return this.reject(id, i, 'bad_horse');
    if (p.horse) return this.reject(id, i, 'already_riding');
    if (!this.near(p, h, this.cfg.horses.range)) return this.reject(id, i, 'too_far');
    if (this.stats.horsesClaimed >= this.cfg.horses.perRaid) return this.reject(id, i, 'horse_cap');
    this.accept(id, i);
    this.stats.horsesClaimed++;
    h.state = 'ridden';
    h.by = id;
    p.horse = h.id;
    this.emit('horse_taken', { accountId: id, horse: h.id, ownerId: h.ownerId }, id);
    return { ok: true };
  }

  on_deliver(p, i, id) {
    if (p.side !== 'attacker') return this.reject(id, i, 'raiders_only');
    if (!this.inPlay(p)) return this.reject(id, i, 'not_in_play');
    if (!this.camp) return this.reject(id, i, 'no_camp');
    if (!this.near(p, this.camp, this.cfg.camp.deliverRange)) return this.reject(id, i, 'not_at_camp');
    if (!this.flagged(p)) return this.reject(id, i, 'nothing_to_deliver');
    const blocker = [...this.players.values()].find((q) =>
      q.side === 'defender' && this.inPlay(q) && dist(q, this.camp) <= this.cfg.camp.deliverBlockedRadius);
    if (blocker) {
      this.emit('delivery_blocked', { accountId: id, by: blocker.id }, id);
      this.stats.blocked++;
      const gap = (this.cfg.scoring.blockedDeliveryIntervalSeconds * 1000) / this.tickMs;
      if (this.tick - p.blockAwardTick >= gap) {
        p.blockAwardTick = this.tick;
        this.addScore('defender', this.cfg.scoring.blockedDeliveryPoints, 'delivery_blocked', blocker.id);
      }
      return this.reject(id, i, 'delivery_blocked');
    }
    this.accept(id, i);
    let pts = p.carrying * this.cfg.scoring.lootDeliveredPerPoint;
    this.stats.delivered += p.carrying;
    p.carrying = 0;
    for (const aid of p.animals) {
      const a = this.animals.find((x) => x.id === aid);
      a.state = 'delivered';
      pts += this.cfg.livestock.points;
    }
    const nAnimals = p.animals.length;
    p.animals = [];
    let horse = null;
    if (p.horse) {
      horse = this.horses.find((x) => x.id === p.horse);
      horse.state = 'held';
      horse.x = this.camp.x; horse.y = this.camp.y;
      p.horse = null;
    }
    this.emit('loot_delivered', { accountId: id, points: pts, animals: nAnimals, horse: horse?.id ?? null }, id);
    this.addScore('attacker', pts, 'delivery', id);
    return { ok: true };
  }

  // ---- scoring and fighting -------------------------------------------------

  addScore(side, pts, reason, accountId) {
    const cap = this.cfg.scoring.raidScoreCap;
    const room = Math.max(0, cap - this.score[side]);
    const given = Math.min(pts, room);
    this.score[side] += given;
    this.emit('score', { side, points: given, requested: pts, reason, total: this.score[side], capped: given < pts }, accountId);
  }

  respawnAt(p, tick) {
    p.state = 'dead';
    p.respawnTick = tick;
  }

  spawnPoint(p) {
    if (p.side === 'attacker') return { x: this.camp.x, y: this.camp.y };
    const s = this.spawns[this.spawnCursor++ % this.spawns.length];
    return { x: s.x, y: s.y };
  }

  dropEverything(p, killerId, cause) {
    if (p.carrying > 0) {
      // Dropped loot goes back to the defenders: pick it up where the carrier fell.
      const cache = this.caches.reduce((a, c) => (dist(p, c) < dist(p, a) ? c : a));
      const d = { id: `d${this.nextId++}`, x: p.x, y: p.y, amount: p.carrying, cache: cache.id };
      this.drops.push(d);
      this.emit('loot_dropped', { accountId: p.id, drop: d.id, amount: d.amount, x: p.x, y: p.y, cause }, p.id);
      p.carrying = 0;
    }
    for (const aid of p.animals) {
      const a = this.animals.find((x) => x.id === aid);
      a.state = 'home'; a.by = null; a.x = a.home.x; a.y = a.home.y;
      this.emit('livestock_returned', { animal: a.id, cause });
    }
    p.animals = [];
    if (p.horse) {
      const h = this.horses.find((x) => x.id === p.horse);
      h.state = 'home'; h.by = null; h.x = h.home.x; h.y = h.home.y;
      this.emit('horse_returned', { horse: h.id, cause });
      p.horse = null;
    }
  }

  defeat(victim, killerId, cause, weapon = null) {
    this.emit('defeat', { attacker: killerId, victim: victim.id, weapon, cause, x: victim.x, y: victim.y, ms: this.tick * this.tickMs }, killerId || 'system');
    this.dropEverything(victim, killerId, cause);
    this.hooks.wear?.(victim.id, this.cfg.combat.wearPct / 100); // keep units and gear, 5% wear
    victim.state = 'dead';
    victim.dx = victim.dy = 0;
    victim.hp = this.cfg.combat.hp;
    victim.respawnTick = this.tick + Math.round((this.cfg.respawn.delaySeconds * 1000) / this.tickMs);
    const killer = killerId && this.players.get(killerId);
    if (killer && killer.side !== victim.side) {
      this.stats.kills[killer.side]++;
      this.addScore(killer.side, this.cfg.scoring.killPoints, 'defeat', killerId);
    }
  }

  // ---- tick loop ------------------------------------------------------------

  speedFor(p) {
    let s = this.cfg.combat.speed;
    if (this.flagged(p)) s *= this.cfg.loot.carrierSpeedMultiplier;
    for (const pl of this.placements) {
      if (Math.floor(pl.x) === Math.floor(p.x) && Math.floor(pl.y) === Math.floor(p.y)) s *= this.cfg.placement.slow[pl.kind];
    }
    return s;
  }

  walk(p, dt) {
    const sp = this.speedFor(p) * dt;
    const { w, h } = this.setup.bounds;
    const nx = Math.min(w - 0.001, Math.max(0, p.x + p.dx * sp));
    if (!this.blocked.has(tileOf(nx, p.y))) p.x = nx;
    const ny = Math.min(h - 0.001, Math.max(0, p.y + p.dy * sp));
    if (!this.blocked.has(tileOf(p.x, ny))) p.y = ny;
  }

  step() {
    if (this.finished) return;
    const pending = this.queue;
    this.queue = [];
    for (const e of pending) this.apply(e);
    if (this.finished) return;
    const dt = this.tickMs / 1000;
    const idleTicks = (this.cfg.war.idleSeconds * 1000) / this.tickMs;
    for (const p of this.players.values()) {
      if (p.state === 'dead' && this.tick >= p.respawnTick && (p.side === 'defender' || this.camp)) {
        const s = this.spawnPoint(p);
        p.x = s.x; p.y = s.y; p.state = 'alive'; p.hp = this.cfg.combat.hp;
        this.emit('respawn', { accountId: p.id, x: p.x, y: p.y }, p.id);
      }
      if (p.state === 'alive') this.walk(p, dt);
      if (this.tick - p.lastInputTick > idleTicks) p.idle = true;
      p.history.unshift({ x: p.x, y: p.y });
      if (p.history.length > 16) p.history.pop();
      if (p.state === 'alive') this.hooks.pos?.(p.id, this.startMs + this.tick * this.tickMs, p.x, p.y, this);
    }
    this.updateSight();
    for (const p of this.players.values()) {
      if (p.state !== 'alive') continue;
      for (const aid of p.animals) { const a = this.animals.find((x) => x.id === aid); a.x = p.x; a.y = p.y; }
      if (p.horse) { const h = this.horses.find((x) => x.id === p.horse); h.x = p.x; h.y = p.y; }
    }
    this.placements = this.placements.filter((pl) => {
      if (this.tick < pl.expireTick) return true;
      this.emit('placement_expired', { id: pl.id });
      return false;
    });
    this.tick++;
    if (this.tick >= this.totalTicks) this.finish('window_end');
  }

  /** First tick each enemy came into view; cleared when they leave. Used for reaction-time checks. */
  updateSight() {
    const view = 20;
    for (const p of this.players.values()) {
      if (p.state !== 'alive') { p.sight.clear(); continue; }
      for (const q of this.players.values()) {
        if (q.side === p.side) continue;
        const seen = q.state === 'alive' && dist(p, q) <= view;
        if (seen && !p.sight.has(q.id)) p.sight.set(q.id, { tick: this.tick, reported: false });
        if (!seen) p.sight.delete(q.id);
      }
    }
  }

  /** Run every tick that is due at wall-clock `now`. */
  advanceTo(now) {
    while (!this.finished && this.startMs + this.tick * this.tickMs <= now) this.step();
  }

  // ---- end of raid -----------------------------------------------------------

  finish(reason) {
    if (this.finished) return this.result;
    this.finished = true;
    // Loot not delivered by the end returns to the caches; nothing survives the window.
    let returned = 0;
    for (const p of this.players.values()) this.dropEverything(p, null, 'window_end');
    for (const d of this.drops) {
      const c = this.caches.find((x) => x.id === d.cache);
      c.loot += d.amount; returned += d.amount;
    }
    this.drops = [];
    this.placements = [];
    const held = this.horses.filter((h) => h.state === 'held');
    if (held.length) this.addScore('attacker', held.length * this.cfg.horses.points, 'held_horses', null);
    const winner = this.score.attacker > this.score.defender ? 'attacker' : 'defender'; // ties go to the defenders
    this.result = {
      reason, winner, score: { ...this.score }, stats: { ...this.stats, kills: { ...this.stats.kills } },
      heldHorses: held.map((h) => ({ id: h.id, ownerId: h.ownerId })), lootReturned: returned,
      deliveredPoints: this.stats.delivered, stateHash: this.stateHash(),
    };
    this.emit('raid_end', this.result);
    return this.result;
  }

  stateHash() {
    const f = (n) => Math.round(n * 1000) / 1000;
    const state = {
      tick: this.tick, score: this.score, camp: this.camp, stats: this.stats,
      caches: this.caches.map((c) => [c.id, c.loot, c.status]),
      players: [...this.players.values()].map((p) => [p.id, p.state, f(p.x), f(p.y), p.hp, p.carrying]),
      horses: this.horses.map((h) => [h.id, h.state]), animals: this.animals.map((a) => [a.id, a.state]),
    };
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
  }

  /** What spectators and clients may see. Never contains anything hidden. */
  publicView() {
    const live = [...this.players.values()].filter((p) => p.state === 'alive');
    return {
      raidId: this.setup.raidId, warId: this.setup.warId, finished: this.finished,
      startMs: this.setup.startMs, endMs: this.setup.endMs,
      msLeft: Math.max(0, this.setup.endMs - (this.setup.startMs + this.tick * this.tickMs)),
      score: { ...this.score }, stats: { ...this.stats, kills: { ...this.stats.kills } },
      goalTiles: this.setup.goalTiles, zoneTiles: this.setup.zoneTiles,
      caches: this.caches.map((c) => ({ id: c.id, x: c.x, y: c.y, status: c.status })),
      camp: this.camp ? { x: this.camp.x, y: this.camp.y } : null,
      players: live.map((p) => ({ id: p.id, side: p.side, x: p.x, y: p.y, carrying: this.flagged(p) })),
      placements: this.placements.map((p) => ({ kind: p.kind, x: p.x, y: p.y })),
    };
  }
}

import { addDays, dateKey, monthKey, DAY, HOUR } from './time.js';

export const tk = (x, y) => `${x},${y}`;
export const parseTile = (k) => k.split(',').map(Number);
export const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Minimal stand-in for the game's existing nations / territory / treasury
 * systems. The war module only talks to the game through this surface, so a
 * real implementation can replace it without touching the rules.
 */
export class World {
  constructor({ cfg, clock = Date.now, width = 256, height = 256 }) {
    this.cfg = cfg;
    this.clock = clock;
    this.width = width;
    this.height = height;
    this.nations = new Map();
    this.owner = new Map(); // tile key -> nation id
    this.blocked = new Set(); // terrain / buildings: block movement and line of sight
    this.landGrace = [];
    this.pairBlocks = []; // { from, to, until, reason }
  }

  addNation({ id, name = id, tiles, capital, createdAt, spawns, homeWindow = 0, treasury = 0, ranks }) {
    const n = {
      id, name, tiles: new Set(tiles.map(([x, y]) => tk(x, y))), capital: tk(...capital),
      createdAt: createdAt ?? this.clock() - 365 * DAY, spawns: spawns || [], homeWindow,
      homeWindowChangedAt: -Infinity, treasury, members: new Map(), allies: new Set(),
      protectedUntil: 0, declareCooldownUntil: 0, shieldUntil: 0, shieldDays: {},
      rankPerms: ranks || { leader: ['declare', 'surrender', 'tribute', 'peace'], officer: ['declare'], member: [] },
    };
    this.nations.set(id, n);
    for (const k of n.tiles) this.owner.set(k, id);
    return n;
  }

  nation(id) {
    const n = this.nations.get(id);
    if (!n) throw new Error(`unknown nation ${id}`);
    return n;
  }

  addMember(nationId, acct) {
    this.nation(nationId).members.set(acct.id, {
      rank: 'member', joinedAt: this.clock() - 30 * DAY, verified: true, weapon: 'sword',
      ip: '0.0.0.0', device: acct.id, linkedGroup: null, ...acct,
    });
  }

  member(nationId, accountId) {
    return this.nation(nationId).members.get(accountId);
  }

  can(nationId, accountId, perm) {
    const m = this.member(nationId, accountId);
    return !!m && (this.nation(nationId).rankPerms[m.rank] || []).includes(perm);
  }

  setAllies(a, b) {
    this.nation(a).allies.add(b);
    this.nation(b).allies.add(a);
  }

  areAllied(a, b) {
    return this.nation(a).allies.has(b);
  }

  sharesMembers(a, b) {
    const A = this.nation(a).members, B = this.nation(b).members;
    const groups = new Set([...B.values()].map((m) => m.linkedGroup).filter(Boolean));
    for (const [id, m] of A) if (B.has(id) || (m.linkedGroup && groups.has(m.linkedGroup))) return true;
    return false;
  }

  isShielded(nationId, now = this.clock()) {
    return this.nation(nationId).shieldUntil > now;
  }

  isProtected(nationId, now = this.clock()) {
    const n = this.nation(nationId);
    return n.protectedUntil > now || now - n.createdAt < this.cfg.war.newNationProtectionHours * HOUR;
  }

  pairBlocked(from, to, now = this.clock()) {
    return this.pairBlocks.some((b) => b.from === from && b.to === to && b.until > now);
  }

  tilesOf(nationId) {
    return [...this.nation(nationId).tiles];
  }

  /** Move tiles between nations. Buildings stay; owners get a grace period for items. */
  transferTiles(fromId, toId, keys, now = this.clock()) {
    const from = this.nation(fromId), to = this.nation(toId);
    for (const k of keys) {
      if (!from.tiles.has(k)) throw new Error(`tile ${k} is not owned by ${fromId}`);
      from.tiles.delete(k);
      to.tiles.add(k);
      this.owner.set(k, toId);
    }
    this.landGrace.push({ fromId, toId, tiles: [...keys], until: now + this.cfg.land.graceHours * HOUR });
  }

  setHomeWindow(nationId, index, now, { warActive }) {
    const n = this.nation(nationId);
    if (!Number.isInteger(index) || index < 0 || index >= this.cfg.windows.length) return { ok: false, reason: 'bad_window' };
    if (warActive) return { ok: false, reason: 'locked_during_war' };
    if (now - n.homeWindowChangedAt < this.cfg.war.homeWindowChangeDays * DAY) return { ok: false, reason: 'changed_this_week' };
    n.homeWindow = index;
    n.homeWindowChangedAt = now;
    return { ok: true };
  }

  setShield(nationId, days, now, { warActive }) {
    const n = this.nation(nationId);
    const mk = monthKey(now, this.cfg.timezone);
    const used = n.shieldDays[mk] || 0;
    if (warActive) return { ok: false, reason: 'war_active' };
    if (!Number.isInteger(days) || days < 1) return { ok: false, reason: 'bad_days' };
    if (used + days > this.cfg.shield.maxDaysPerMonth) return { ok: false, reason: 'shield_budget_exceeded' };
    n.shieldDays[mk] = used + days;
    n.shieldUntil = now + days * DAY;
    return { ok: true, until: n.shieldUntil };
  }

  /** Items on lost land: owners may still move items until the grace ends. */
  inLandGrace(accountId, nationId, tile, now = this.clock()) {
    return this.landGrace.some((g) => g.fromId === nationId && g.until > now && g.tiles.includes(tile));
  }

  dayKey(ms) {
    return dateKey(ms, this.cfg.timezone);
  }

  nextDay(key) {
    return addDays(key, 1);
  }
}

export function connected(keys) {
  const set = new Set(keys);
  if (!set.size) return true;
  const seen = new Set();
  const stack = [set.values().next().value];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    const [x, y] = parseTile(k);
    for (const [dx, dy] of NEIGHBORS) {
      const nk = tk(x + dx, y + dy);
      if (set.has(nk) && !seen.has(nk)) stack.push(nk);
    }
  }
  return seen.size === set.size;
}

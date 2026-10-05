import { createHmac, timingSafeEqual } from 'node:crypto';

// Message schema: field name -> type. Anything else is refused.
const SCHEMA = {
  join: {}, leave: {}, activity: {}, deliver: {},
  move: { dx: 'num', dy: 'num' },
  attack: { target: 'str' },
  place: { kind: 'str', x: 'num', y: 'num' },
  place_camp: { x: 'num', y: 'num' },
  pickup_loot: { cache: 'str' },
  recover_loot: { drop: 'str' },
  claim_horse: { horse: 'str' },
  drive_livestock: { animal: 'str' },
  pong: { nonce: 'str' },
};

// Things the zone forbids outright. The server refuses them and records the attempt.
const BANNED = new Set([
  'teleport', 'ender_pearl', 'fly', 'glide', 'elytra', 'store_loot', 'deposit', 'trade_loot', 'craft_loot',
  'damage_building', 'explosive', 'tnt', 'ignite', 'fire', 'lava', 'boat', 'cargo_boat',
  'set_position', 'hit', 'claim_hit', 'set_score',
]);

const b64 = (b) => Buffer.from(b).toString('base64url');

/**
 * Part 1 of Raid Guard: exact rules the server enforces itself. Everything here
 * is a hard yes/no, so there are no false flags and no statistics.
 */
export class Guard {
  constructor({ cfg, secret, log, clock = Date.now, detector = null }) {
    this.cfg = cfg.guard;
    this.secret = secret;
    this.log = log;
    this.clock = clock;
    this.detector = detector;
    this.sessions = new Map(); // connId -> session
    this.byAccount = new Map(); // accountId -> connId (one connection per account)
  }

  issueToken(accountId, now = this.clock()) {
    const body = b64(JSON.stringify({ a: accountId, exp: now + this.cfg.tokenTtlSeconds * 1000 }));
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  verifyToken(token, now = this.clock()) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = createHmac('sha256', this.secret).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const { a, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
      return exp > now ? a : null;
    } catch { return null; }
  }

  open(connId, token, { ip = '', device = '' } = {}, now = this.clock()) {
    const accountId = this.verifyToken(token, now);
    if (!accountId) return { ok: false, reason: 'bad_token' };
    if (this.byAccount.has(accountId)) {
      this.log.append('rejected', { actor: accountId, data: { reason: 'second_connection', ip } });
      return { ok: false, reason: 'second_connection' };
    }
    this.sessions.set(connId, { accountId, ip, device, lastSeq: 0, tokens: this.cfg.burst, refilledAt: now, logged: 0, loggedAt: now, suppressed: 0 });
    this.byAccount.set(accountId, connId);
    return { ok: true, accountId };
  }

  close(connId) {
    const s = this.sessions.get(connId);
    if (!s) return;
    this.sessions.delete(connId);
    this.byAccount.delete(s.accountId);
  }

  refuse(s, type, reason, now) {
    this.detector?.onRejected(s.accountId, now, reason);
    if (now - s.loggedAt >= 1000) { s.loggedAt = now; s.logged = 0; }
    if (s.logged++ < this.cfg.logRejectsPerSecond) {
      this.log.append('rejected', { actor: s.accountId, data: { type, reason, suppressedBefore: s.suppressed } });
      s.suppressed = 0;
    } else s.suppressed++;
    return { ok: false, reason };
  }

  /** Validate one raw message. Returns { ok, accountId, msg } or { ok:false, reason }. */
  handle(connId, raw, now = this.clock()) {
    const s = this.sessions.get(connId);
    if (!s) return { ok: false, reason: 'no_session' };
    s.tokens = Math.min(this.cfg.burst, s.tokens + ((now - s.refilledAt) / 1000) * this.cfg.maxMessagesPerSecond);
    s.refilledAt = now;
    if (s.tokens < 1) return this.refuse(s, '?', 'rate_limited', now);
    s.tokens -= 1;

    if (typeof raw !== 'string' || Buffer.byteLength(raw) > this.cfg.maxMessageBytes) return this.refuse(s, '?', 'too_large', now);
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.refuse(s, '?', 'bad_json', now); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.refuse(s, '?', 'bad_shape', now);
    const { t, seq, ...fields } = msg;
    if (typeof t !== 'string') return this.refuse(s, '?', 'bad_type', now);
    if (!Number.isSafeInteger(seq) || seq <= s.lastSeq) return this.refuse(s, t, 'replayed_or_out_of_order', now);
    s.lastSeq = seq;
    if (BANNED.has(t)) return this.refuse(s, t, 'banned_action', now);
    const schema = SCHEMA[t];
    if (!schema) return this.refuse(s, t, 'unknown_type', now);
    const keys = Object.keys(fields);
    if (keys.length !== Object.keys(schema).length) return this.refuse(s, t, 'bad_fields', now);
    for (const [k, ty] of Object.entries(schema)) {
      const v = fields[k];
      if (ty === 'num' && !(typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e5)) return this.refuse(s, t, 'bad_fields', now);
      if (ty === 'str' && !(typeof v === 'string' && v.length > 0 && v.length <= 64)) return this.refuse(s, t, 'bad_fields', now);
    }
    this.detector?.onAccepted(s.accountId, now);
    return { ok: true, accountId: s.accountId, msg: { t, ...fields } };
  }
}

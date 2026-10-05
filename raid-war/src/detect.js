import { randomBytes } from 'node:crypto';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/**
 * Part 2 of Raid Guard: statistical checks. These only flag and log for staff
 * review. Nothing in this class can ban, kick or punish anyone.
 */
export class Detector {
  constructor({ cfg, log, clock = Date.now }) {
    this.c = cfg.antiCheat;
    this.log = log;
    this.clock = clock;
    this.evidence = new Map(); // accountId -> [{ms, kind, data}]
    this.nonces = new Map(); // nonce -> {accountId, sentAt}
    this.ping = new Map(); // accountId -> smoothed rtt ms
    this.attackTimes = new Map();
    this.reactions = new Map();
    this.violations = new Map();
    this.rejects = new Map();
    this.lastBreak = new Map();
    this.lastInput = new Map();
    this.raidInputs = new Map(); // raidId -> Map(accountId -> [ms])
    this.sessions = new Map(); // raidId -> Map(accountId -> {ip, device})
    this.lastFlag = new Map();
    this.queue = [];
    this.nextFlag = 1;
  }

  // ---- evidence ring buffer (last N seconds per player) -----------------------

  record(accountId, ms, kind, data = {}) {
    let buf = this.evidence.get(accountId);
    if (!buf) this.evidence.set(accountId, (buf = []));
    buf.push({ ms, kind, data });
    const cutoff = ms - this.c.evidenceSeconds * 1000;
    while (buf.length && buf[0].ms < cutoff) buf.shift();
  }

  snapshot(accountId) {
    return structuredClone(this.evidence.get(accountId) || []);
  }

  // ---- real ping: server-measured, random nonce ---------------------------------

  newPing(accountId, now = this.clock()) {
    const nonce = randomBytes(8).toString('hex');
    this.nonces.set(nonce, { accountId, sentAt: now });
    if (this.nonces.size > 5000) this.nonces.delete(this.nonces.keys().next().value);
    return nonce;
  }

  /** Returns the smoothed ping, or null when the nonce is unknown or belongs to someone else. */
  pong(accountId, nonce, now = this.clock()) {
    const n = this.nonces.get(nonce);
    if (!n || n.accountId !== accountId) return null;
    this.nonces.delete(nonce);
    const rtt = Math.max(0, now - n.sentAt);
    const prev = this.ping.get(accountId);
    const sm = prev === undefined ? rtt : prev * 0.7 + rtt * 0.3;
    this.ping.set(accountId, sm);
    return Math.round(sm);
  }

  // ---- rejected actions ------------------------------------------------------------

  onAccepted(accountId, now) { this.pushRate(accountId, now, false); }

  onRejected(accountId, now, reason) {
    this.pushRate(accountId, now, true);
    const w = this.rejects.get(accountId);
    const rej = w.filter((e) => e.r).length;
    if (rej >= this.c.rejectedRate.minRejected && rej / w.length >= this.c.rejectedRate.ratio) {
      this.flag('rejected_action_rate', accountId, null, { rejected: rej, total: w.length, lastReason: reason }, now);
    }
  }

  pushRate(accountId, now, r) {
    let w = this.rejects.get(accountId);
    if (!w) this.rejects.set(accountId, (w = []));
    w.push({ t: now, r });
    const cutoff = now - this.c.rejectedRate.windowSeconds * 1000;
    while (w.length && w[0].t < cutoff) w.shift();
  }

  // ---- hit validation: only flags after several gross violations in a row --------------

  onHitCheck(info, now) {
    const n = info.gross ? (this.violations.get(info.attacker) || 0) + 1 : 0;
    this.violations.set(info.attacker, n);
    this.record(info.attacker, info.ms, 'hit_check', info);
    if (n >= this.c.consecutiveHitViolations) {
      this.flag('hit_validation', info.attacker, info.raidId, { consecutive: n, last: info }, now ?? info.ms);
      this.violations.set(info.attacker, 0);
    }
  }

  // ---- bot and macro signals ---------------------------------------------------------------

  onReaction(accountId, reactionMs, raidId, now) {
    const b = this.c.bot;
    const arr = this.reactions.get(accountId) || [];
    arr.push(reactionMs);
    if (arr.length > b.reactionSamples) arr.shift();
    this.reactions.set(accountId, arr);
    if (arr.length === b.reactionSamples && arr.every((r) => r < b.minReactionMs)) {
      this.flag('inhuman_reaction', accountId, raidId, { samples: [...arr] }, now);
      this.reactions.set(accountId, []);
    }
  }

  onInput(accountId, ms, intent, raidId) {
    const b = this.c.bot;
    this.record(accountId, ms, 'input', intent);
    // regular timing: attack presses spaced almost perfectly evenly
    if (intent.t === 'attack') {
      const a = this.attackTimes.get(accountId) || [];
      a.push(ms);
      if (a.length > b.minSamples + 1) a.shift();
      this.attackTimes.set(accountId, a);
      if (a.length > b.minSamples) {
        const iv = a.slice(1).map((t, i) => t - a[i]);
        const m = mean(iv);
        const cv = Math.sqrt(mean(iv.map((x) => (x - m) ** 2))) / m;
        if (m > 0 && cv < b.maxIntervalCv) this.flag('regular_input_timing', accountId, raidId, { cv, meanMs: m, samples: iv.length }, ms);
      }
    }
    // no breaks: input never pauses for breakGapSeconds across noBreakMinutes
    const last = this.lastInput.get(accountId);
    if (last === undefined || ms - last >= b.breakGapSeconds * 1000) this.lastBreak.set(accountId, ms);
    this.lastInput.set(accountId, ms);
    if (ms - this.lastBreak.get(accountId) >= b.noBreakMinutes * 60000) {
      this.flag('no_breaks', accountId, raidId, { minutes: (ms - this.lastBreak.get(accountId)) / 60000 }, ms);
      this.lastBreak.set(accountId, ms);
    }
    // keep timing for multi-account correlation
    let r = this.raidInputs.get(raidId);
    if (!r) this.raidInputs.set(raidId, (r = new Map()));
    const t = r.get(accountId) || [];
    t.push(ms);
    if (t.length > 2000) t.shift();
    r.set(accountId, t);
  }

  // ---- multi-account signals ------------------------------------------------------------------

  registerSession(raidId, accountId, { ip, device }) {
    let r = this.sessions.get(raidId);
    if (!r) this.sessions.set(raidId, (r = new Map()));
    r.set(accountId, { ip, device });
  }

  /** Same IP or device in one raid, or inputs landing within a few ms of each other. */
  checkRaid(raidId, now = this.clock()) {
    const out = [];
    const s = [...(this.sessions.get(raidId) || [])];
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        const [a, A] = s[i], [b, B] = s[j];
        if (A.ip && A.ip === B.ip) out.push(this.flag('same_ip', a, raidId, { with: b, ip: A.ip }, now));
        if (A.device && A.device === B.device) out.push(this.flag('same_device', a, raidId, { with: b, device: A.device }, now));
      }
    }
    const inputs = [...(this.raidInputs.get(raidId) || [])];
    const m = this.c.multiAccount;
    for (let i = 0; i < inputs.length; i++) {
      for (let j = i + 1; j < inputs.length; j++) {
        const [a, ta] = inputs[i], [b, tb] = inputs[j];
        if (ta.length < m.minSamples || tb.length < m.minSamples) continue;
        const close = ta.filter((x) => tb.some((y) => Math.abs(x - y) <= m.correlationWindowMs)).length;
        if (close / ta.length >= m.correlationRatio) out.push(this.flag('correlated_input_timing', a, raidId, { with: b, ratio: close / ta.length }, now));
      }
    }
    return out.filter(Boolean);
  }

  // ---- flags and staff review --------------------------------------------------------------------

  flag(kind, accountId, raidId, details, now = this.clock()) {
    const key = `${kind}|${accountId}|${raidId}`;
    const last = this.lastFlag.get(key);
    if (last !== undefined && now - last < this.c.flagCooldownSeconds * 1000) return null;
    this.lastFlag.set(key, now);
    const f = {
      id: `F${this.nextFlag++}`, kind, accountId, raidId, details, status: 'open', createdAt: now,
      evidence: this.snapshot(accountId),
      alertOnly: !!this.c.alertOnlyUntil && now < Date.parse(this.c.alertOnlyUntil),
    };
    this.queue.push(f);
    this.log.append('anticheat_flag', { raidId, actor: 'raid_guard', data: { id: f.id, kind, accountId, details, evidence: f.evidence, alertOnly: f.alertOnly } });
    return f;
  }

  /** Staff decision on a flag. This records a verdict; it never punishes by itself. */
  review(flagId, staffId, status, note = '') {
    const f = this.queue.find((x) => x.id === flagId);
    if (!f || !['dismissed', 'confirmed'].includes(status)) return { ok: false };
    f.status = status;
    this.log.append('anticheat_review', { raidId: f.raidId, actor: staffId, data: { flagId, status, note } });
    return { ok: true };
  }

  open() { return this.queue.filter((f) => f.status === 'open'); }
}

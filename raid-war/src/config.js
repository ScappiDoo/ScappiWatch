// Every number from the design doc (section 12) lives here. Nothing in the
// rest of the code base hard-codes a rule value.
export const DEFAULTS = Object.freeze({
  timezone: 'Europe/Copenhagen',
  windows: ['16:00', '19:00', '22:00'],
  windowMinutes: 90,
  server: { tickRate: 20 },
  war: {
    noticeHours: 24,
    homeWindowChangeDays: 7,
    minRaiders: 3,
    minDefenders: 3,
    idleSeconds: 120,
    raiderCapOver: 2,
    eligibleMemberAgeDays: 7,
    newNationProtectionHours: 72,
    maxAlliesPerSide: 2,
    maxActiveWars: 2,
    raidsToWin: 2,
    maxRaidsPerTargetPerDay: 1,
    defenderNoShowsToForfeit: 2,
    raiderNoShowCooldownHours: 24,
    expireAfterDays: 14, // gap-filler: a war stuck on cancelled raids ends with no land change
  },
  shield: { maxDaysPerMonth: 7 },
  zone: { borderStrip: 8 },
  caches: { count: 3, minSpacing: 8, lockMinutesBeforeWindow: 30, pointsPerCache: 60, lootChunk: 10, pickupRange: 2, recoverRange: 2 },
  camp: { minDistFromCache: 16, deliverBlockedRadius: 3, deliverRange: 2 },
  loot: { mode: 'points', silverMaxTreasuryPct: 3, carrierSpeedMultiplier: 0.8, carryCap: 40 },
  livestock: { perRaid: 10, points: 1, range: 2 },
  horses: { perRaid: 3, points: 15, range: 2, buybackPrice: 100 },
  placement: { range: 4, lifetimeSeconds: 10, kinds: ['web', 'water'], cooldownSeconds: 2, maxActive: 6, slow: { web: 0.4, water: 0.7 } },
  respawn: { delaySeconds: 20, defenderMinCacheDistance: 6 },
  combat: {
    hp: 100,
    speed: 4, // tiles per second
    wearPct: 5,
    fightSeconds: 5, // a disconnect this soon after combat counts as a defeat
    maxRewindMs: 250,
    rangeTolerance: 0.5,
    weapons: {
      sword: { range: 2, damage: 25, cooldownMs: 600, needsLos: false },
      spear: { range: 3, damage: 20, cooldownMs: 800, needsLos: false },
      bow: { range: 16, damage: 12, cooldownMs: 1000, needsLos: true },
    },
  },
  land: { pct: 10, maxTiles: 20, minTiles: 2, graceHours: 72 },
  tribute: { enabled: false, maxTreasuryPct: 5, protectionDays: 3 },
  protection: { afterLostWarDays: 7, attackerLossCooldownDays: 7 },
  scoring: { killPoints: 10, lootDeliveredPerPoint: 1, lootRecoveredPerPoint: 1, blockedDeliveryPoints: 2, blockedDeliveryIntervalSeconds: 10, raidScoreCap: 300 },
  guard: { maxMessageBytes: 512, maxMessagesPerSecond: 40, burst: 60, logRejectsPerSecond: 5, tokenTtlSeconds: 3600 },
  antiCheat: {
    evidenceSeconds: 10,
    alertOnlyUntil: null, // ISO date; flags never punish either way, this only marks the launch period
    consecutiveHitViolations: 5,
    hitGrossMargin: 2, // tiles beyond (range + tolerance) before a miss counts as a violation
    flagCooldownSeconds: 300,
    bot: { minSamples: 50, maxIntervalCv: 0.02, minReactionMs: 100, reactionSamples: 5, noBreakMinutes: 20, breakGapSeconds: 3 },
    multiAccount: { minSamples: 40, correlationWindowMs: 5, correlationRatio: 0.6 },
    rejectedRate: { windowSeconds: 60, minRejected: 20, ratio: 0.3 },
  },
  retention: { logDays: 30, replayDays: 30, disputeHours: 24 },
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(overrides = {}) {
  const cfg = merge(DEFAULTS, overrides);
  if (cfg.windows.length !== 3) throw new Error('config: exactly three raid windows are required');
  for (const w of cfg.windows) if (!/^\d{2}:\d{2}$/.test(w)) throw new Error(`config: bad window ${w}`);
  if (cfg.server.tickRate < 1) throw new Error('config: tickRate must be >= 1');
  cfg.tickMs = 1000 / cfg.server.tickRate;
  return deepFreeze(cfg);
}

function deepFreeze(o) {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
  return Object.freeze(o);
}

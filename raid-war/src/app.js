import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { EventLog } from './eventlog.js';
import { World } from './world.js';
import { WarManager, Presence } from './war.js';
import { Guard } from './guard.js';
import { Detector } from './detect.js';
import { Gateway } from './gateway.js';
import { Staff } from './staff.js';
import { DiscordFeed } from './discord.js';
import { Db } from './db.js';
import { Persistence } from './persist.js';
import { spectatorRoutes } from './server.js';
import { attachWebSocket } from './ws-server.js';

/**
 * Wires everything together: database, rules, anti-cheat, WebSocket and spectator
 * server. `seedWorld(world)` runs only when the database holds no saved world, so
 * a real game would load its nations here instead.
 */
export function createApp({
  dbPath = ':memory:', secret, clock = Date.now, config = {}, seedWorld = null, discordSend = null,
  isStaff = () => false, trustProxy = false, ws: wsOptions = {},
}) {
  if (!secret || secret.length < 16) throw new Error('a token secret of at least 16 characters is required');
  const cfg = loadConfig(config);
  const db = new Db(dbPath);
  const log = new EventLog({ clock, retentionMs: cfg.retention.logDays * 86400000 });
  const world = new World({ cfg, clock });
  const presence = new Presence();
  const detector = new Detector({ cfg, log, clock });
  const hooks = {
    input: (id, tick, intent, raid) => detector.onInput(id, raid.startMs + tick * raid.tickMs, intent, raid.setup.raidId),
    hitCheck: (i) => detector.onHitCheck(i),
    reaction: (id, ms, raid) => detector.onReaction(id, ms, raid.setup.raidId, raid.startMs),
    pos: (id, ms, x, y) => detector.record(id, ms, 'pos', { x, y }),
    rejected: (id, reason, tick, raid) => detector.onRejected(id, raid.startMs + tick * raid.tickMs, reason),
  };
  const wm = new WarManager({ world, log, cfg, clock, hooks, presence });
  const guard = new Guard({ cfg, secret, log, clock, detector });
  const gateway = new Gateway({ wm, guard, detector, clock });
  const staff = new Staff({ manager: wm, isStaff, clock });
  const persistence = new Persistence({ db, log, world, wm });

  // ---- load what the last run saved, then start recording --------------------------
  log.restore(db.loadEvents(), db.getKv('anchor') ?? 'GENESIS');
  const restored = persistence.restore();
  if (!restored && seedWorld) { seedWorld(world); persistence.save(); }
  persistence.start();
  detector.restoreFromLog(log);
  staff.restoreFromLog(log);
  if (restored) wm.resumeRaids(clock());
  if (discordSend) new DiscordFeed({ log, send: discordSend });

  // ---- network ----------------------------------------------------------------------
  const routes = spectatorRoutes({ wm, log });
  const http = createServer(async (req, res) => {
    try { if (!(await routes.handle(req, res))) res.writeHead(404).end(); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  const ws = attachWebSocket({ server: http, gateway, wm, clock, trustProxy, ...wsOptions });

  const lastCheck = new Map();
  let lastPrune = clock(), timers = [];
  const app = {
    cfg, db, log, world, wm, guard, detector, gateway, staff, persistence, http, ws, restored,

    /** One step of the server loop: rules, anti-cheat sweeps, saving. */
    tick(now = clock()) {
      wm.tick(now);
      for (const raid of wm.raids.values()) {
        const id = raid.setup.raidId;
        if (raid.finished && !lastCheck.has(`done:${id}`)) { lastCheck.set(`done:${id}`, 1); detector.checkRaid(id, now); }
        else if (!raid.finished && now - (lastCheck.get(id) ?? 0) >= 60000) { lastCheck.set(id, now); detector.checkRaid(id, now); }
      }
      if (now - lastPrune > 3600000) { lastPrune = now; log.prune(now); }
      persistence.flush();
    },

    listen(port = 8080, host = '0.0.0.0') {
      return new Promise((resolve) => http.listen(port, host, () => resolve(http.address().port)));
    },

    /** Start the real-time loop: 20 Hz rules tick, 10 Hz state push. */
    start() {
      timers.push(setInterval(() => app.tick(), 1000 / cfg.server.tickRate));
      timers.push(setInterval(() => ws.broadcast(), 100));
    },

    async stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      ws.close();
      routes.close();
      await new Promise((r) => http.close(r));
      persistence.flush();
      db.close();
    },
  };
  return app;
}

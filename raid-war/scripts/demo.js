// Demo: a war between two test nations with scripted bots, played on a fast clock so a
// 90 minute raid window takes about 90 seconds. Open http://localhost:8080 to watch.
import { makeEnv, declare, connectAll } from '../test/helpers.js';
import { createSpectatorServer } from '../src/server.js';
import { DiscordFeed } from '../src/discord.js';

const speed = Number(process.env.SPEED || 60);
const env = makeEnv();
const real0 = Date.now(), sim0 = env.clock.t;
const now = () => sim0 + (Date.now() - real0) * speed;
env.wm.clock = now;
const feed = new DiscordFeed({ log: env.log, send: (t) => console.log('[discord]', t.replaceAll('\n', ' | ')) });
void feed;
const { warId } = declare(env);
const war = env.wm.wars.get(warId);
env.clock.t = war.slot.startMs - 3 * 60000; // start just before the first window
const sim1 = war.slot.startMs - 3 * 60000;
const t1 = Date.now();
const clock = () => sim1 + (Date.now() - t1) * speed;
env.wm.clock = clock;
connectAll(env, sim1 - 3600000);

const ids = { attacker: ['v1', 'v2', 'v3', 'v4'], defender: ['s1', 's2', 's3', 's4'] };
setInterval(() => {
  const t = clock();
  for (const id of [...ids.attacker, ...ids.defender]) env.presence.touch(id, t);
  env.wm.tick(t);
  const raid = war.raidId && env.wm.raids.get(war.raidId);
  if (!raid) return;
  for (const id of [...ids.attacker, ...ids.defender]) if (raid.players.get(id)?.state === 'out') raid.enqueue(id, { t: 'join' });
  const v1 = raid.players.get('v1');
  if (!raid.camp && v1.state !== 'out') raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  for (const id of ids.attacker) {
    const p = raid.players.get(id);
    if (p.state !== 'alive') continue;
    const dest = p.carrying >= 20 || raid.caches.every((c) => c.loot <= 0) ? raid.camp : raid.caches.filter((c) => c.loot > 0).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    if (!dest) continue;
    const d = Math.hypot(dest.x - p.x, dest.y - p.y);
    if (d < 1.5) raid.enqueue(id, dest === raid.camp ? { t: 'deliver' } : { t: 'pickup_loot', cache: dest.id });
    else raid.enqueue(id, { t: 'move', dx: (dest.x - p.x) / d, dy: (dest.y - p.y) / d });
  }
  for (const id of ids.defender) {
    const p = raid.players.get(id);
    if (p.state !== 'alive') continue;
    const foe = ids.attacker.map((a) => raid.players.get(a)).filter((q) => q.state === 'alive').sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    if (!foe) continue;
    const d = Math.hypot(foe.x - p.x, foe.y - p.y);
    raid.enqueue(id, { t: 'move', dx: (foe.x - p.x) / d, dy: (foe.y - p.y) / d });
    if (d <= 2) raid.enqueue(id, { t: 'attack', target: foe.id });
  }
}, 100);
const web = createSpectatorServer({ wm: env.wm, log: env.log, port: Number(process.env.PORT || 8080) });
await web.listen();
console.log(`Spectator page on http://localhost:${process.env.PORT || 8080} (clock x${speed})`);

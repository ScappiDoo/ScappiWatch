// Load test: a raid with simulated clients going through the real gateway/guard.
// Prints the average and worst time per tick against the 50 ms budget (20 ticks/s).
import { makeEnv, declare, connectAll, run } from '../test/helpers.js';
import { Gateway } from '../src/gateway.js';

const PER_SIDE = Number(process.env.PER_SIDE || 25);
const TICKS = Number(process.env.TICKS || 12000); // 10 minutes
const env = makeEnv({ guard: { maxMessagesPerSecond: 200, burst: 200 } });
for (let i = 6; i <= PER_SIDE; i++) {
  env.world.addMember('vik', { id: `v${i}` });
  env.world.addMember('sax', { id: `s${i}` });
}
const { warId } = declare(env);
const war = env.wm.wars.get(warId);
const gw = new Gateway({ wm: env.wm, guard: env.guard, detector: env.detector, clock: () => env.clock.t });
const s = war.slot;
connectAll(env, s.startMs - 3600000);
for (const n of ['vik', 'sax']) for (const id of env.world.nation(n).members.keys()) env.presence.touch(id, s.startMs - 1000);
env.clock.t = s.startMs;
env.wm.tick(env.clock.t);
const raid = env.wm.raids.get(war.raidId);
const ids = [...raid.players.keys()];
// Swap the test presence for real gateway connections, one per player.
for (const id of ids) env.presence.disconnect(id);
const seq = new Map();
ids.forEach((id, i) => {
  const r = gw.connect(`c-${id}`, env.guard.issueToken(id), { ip: `10.1.${i}.1`, device: id }, s.startMs - 10);
  if (!r.ok) throw new Error(JSON.stringify(r));
});
for (const id of ids) raid.enqueue(id, { t: 'join' });
run(env, raid, 2);
raid.enqueue(ids.find((i) => i.startsWith('v')), { t: 'place_camp', x: 20.5, y: 45.5 });
run(env, raid, 3);
let worst = 0, total = 0, seed = 1;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
for (let t = 0; t < TICKS; t++) {
  for (const id of ids) {
    if (rnd() < 0.5) {
      const n = (seq.get(id) || 0) + 1; seq.set(id, n);
      const a = rnd() * 6.28;
      gw.message(`c-${id}`, JSON.stringify({ t: 'move', seq: n, dx: Math.cos(a), dy: Math.sin(a) }), env.clock.t);
    }
  }
  const t0 = performance.now();
  run(env, raid, 1);
  const dt = performance.now() - t0;
  total += dt; worst = Math.max(worst, dt);
}
console.log(`${ids.length} clients, ${TICKS} ticks: avg ${(total / TICKS).toFixed(3)} ms/tick, worst ${worst.toFixed(2)} ms/tick, budget 50 ms`);
console.log(`log events ${env.log.events.length}, open anti-cheat flags ${env.detector.open().length}`);
if (total / TICKS > 25) { console.error('FAIL: server cannot hold the tick rate with headroom'); process.exit(1); }

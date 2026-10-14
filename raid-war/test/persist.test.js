import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { seedDemoWorld } from '../src/demo-world.js';
import { replayRaid } from '../src/replay.js';
import { T0, GOAL } from './helpers.js';

const SECRET = 'test-secret-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'raidwar-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const open = (path, clock) => createApp({ dbPath: path, secret: SECRET, clock: () => clock.t, seedWorld: seedDemoWorld, isStaff: (id) => id.startsWith('staff') });
const newPath = () => join(dir, `db${n++}.sqlite`);
const declare = (app, clock) => app.wm.declare({ attackerId: 'vik', targetId: 'sax', byAccount: 'v1', reason: 'They insulted our jarl', goalTiles: GOAL }, clock.t);

function startRaid(app, clock, warId) {
  const war = app.wm.wars.get(warId), s = war.slot;
  for (const id of ['v1', 'v2', 'v3', 's1', 's2', 's3']) app.wm.presence.connect(id, s.startMs - 20 * 60000);
  clock.t = s.startMs - 5 * 60000; app.tick();
  for (const id of ['v1', 'v2', 'v3', 's1', 's2', 's3']) app.wm.presence.touch(id, s.startMs - 30000);
  clock.t = s.startMs; app.tick();
  return app.wm.raids.get(war.raidId);
}
const run = (app, clock, raid, ticks) => { for (let i = 0; i < ticks; i++) { clock.t = raid.startMs + raid.tick * raid.tickMs; app.tick(); } };

test('events and state survive a restart; the hash chain is checked on load', async () => {
  const path = newPath(), clock = { t: T0 };
  let app = open(path, clock);
  assert.equal(app.restored, false);
  assert.equal(app.wm.setHomeWindow('vik', 2, 'v1', clock.t).ok, true);
  const { warId } = declare(app, clock);
  const eventCount = app.log.events.length;
  const slot = { ...app.wm.wars.get(warId).slot };
  await app.stop();

  app = open(path, clock);
  assert.equal(app.restored, true);
  assert.equal(app.log.events.length, eventCount);
  assert.equal(app.log.verify(), true);
  const war = app.wm.wars.get(warId);
  assert.deepEqual(war.goalTiles, GOAL);
  assert.equal(war.slot.startMs, slot.startMs);
  assert.equal(app.world.nation('sax').tiles.size, 200);
  assert.equal(app.world.owner.get('40,40'), 'sax');
  assert.equal(app.world.nation('vik').members.get('v1').rank, 'leader');
  assert.equal(app.world.nation('vik').homeWindow, 2);
  assert.equal(app.world.nation('vik').homeWindowChangedAt, T0);
  assert.equal(app.world.nation('sax').homeWindowChangedAt, -Infinity);
  // the slot is still booked, so a second war on the same day is pushed back
  assert.equal(app.wm.bookings.get(`sax|${slot.day}`), 1);
  await app.stop();
});

test('a tampered database is refused at start', async () => {
  const path = newPath(), clock = { t: T0 };
  const app = open(path, clock);
  declare(app, clock);
  await app.stop();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE events SET data = replace(data, 'insulted', 'praised') WHERE type = 'war_declared'").run();
  raw.close();
  assert.throws(() => open(path, clock), /hash-chain/);
});

test('a raid that was running is rebuilt from the log and carries on', async () => {
  const path = newPath(), clock = { t: T0 };
  let app = open(path, clock);
  const { warId } = declare(app, clock);
  let raid = startRaid(app, clock, warId);
  for (const id of ['v1', 's1']) raid.enqueue(id, { t: 'join' });
  run(app, clock, raid, 2);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(app, clock, raid, 3);
  const raidId = raid.setup.raidId;
  const before = { camp: raid.camp, caches: raid.caches.map((x) => x.loot) };
  clock.t += 10000;
  await app.stop();

  app = open(path, clock);
  assert.equal(app.wm.wars.get(warId).raidId, raidId);
  raid = app.wm.raids.get(raidId);
  assert.ok(raid && !raid.finished);
  assert.deepEqual(raid.camp, before.camp);
  assert.deepEqual(raid.caches.map((x) => x.loot), before.caches);
  assert.equal(app.log.query({ raidId, type: 'server_restart' }).length, 1);
  // the missed ticks run with everyone disconnected and standing still
  clock.t = raid.startMs + 20 * raid.tickMs; app.tick();
  assert.equal(app.log.query({ raidId, type: 'input' }).filter((e) => e.data.intent.t === 'sys_disconnect').length, 6);
  assert.ok([...raid.players.values()].every((p) => !p.connected && p.dx === 0 && p.dy === 0));
  // the window still ends on time, the war carries on, and the resumed raid still replays
  clock.t = raid.setup.endMs; app.tick();
  assert.ok(raid.finished);
  assert.equal(app.wm.wars.get(warId).raidId, null);
  assert.equal(replayRaid(app.log, raidId, app.cfg).ok, true);
  await app.stop();
});

test('storage locks are re-asserted after a restart', async () => {
  const path = newPath(), clock = { t: T0 };
  let app = open(path, clock);
  const { warId } = declare(app, clock);
  const war = app.wm.wars.get(warId);
  clock.t = war.slot.lockAt + 1000; app.tick();
  assert.equal(war.slot.locked, true);
  await app.stop();
  app = open(path, clock);
  const calls = [];
  app.wm.hooks.lockStorage = (id, on) => calls.push([id, on]);
  app.wm.resumeRaids(clock.t);
  assert.deepEqual(calls, [['sax', true]]);
  await app.stop();
});

test('retention prune removes old rows and keeps the chain verifiable across restarts', async () => {
  const path = newPath(), clock = { t: T0 };
  let app = open(path, clock);
  declare(app, clock);
  const before = app.log.events.length;
  clock.t += 31 * 86400000;
  app.log.append('late');
  const removed = app.log.prune(clock.t);
  assert.equal(removed, before);
  app.persistence.flush();
  await app.stop();
  app = open(path, clock);
  assert.equal(app.log.events.length, 1);
  assert.equal(app.log.verify(), true);
  await app.stop();
});

test('flags, staff proposals and tickets come back after a restart', async () => {
  const path = newPath(), clock = { t: T0 };
  let app = open(path, clock);
  const { warId } = declare(app, clock);
  app.wm.surrender(warId, 'defender', 's1');
  app.staff.undo(warId, 'staff1', 'check');
  const f = app.detector.flag('hit_validation', 'v1', 'R1-1', { n: 5 }, clock.t);
  app.persistence.flush();
  await app.stop();
  app = open(path, clock);
  assert.equal(app.detector.open()[0].id, f.id);
  assert.equal(app.staff.undo(warId, 'staff1', 'again').reason, 'second_staff_must_differ');
  assert.equal(app.staff.undo(warId, 'staff2', 'agree').status, 'undone');
  assert.equal(app.world.nation('vik').tiles.size, 200);
  await app.stop();
});

test('discord webhook sender posts in order, backs off on 429, and never pings anyone', async () => {
  const { createWebhookSender } = await import('../src/discord-webhook.js');
  const calls = [];
  let first = true;
  const fetchFn = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    if (first) { first = false; return { status: 429, ok: false, json: async () => ({ retry_after: 0.01 }) }; }
    return { status: 204, ok: true };
  };
  const send = createWebhookSender('http://hook', { fetchFn, minGapMs: 1 });
  send('one @everyone'); send('two');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(calls.map((c) => c.content), ['one @everyone', 'one @everyone', 'two']);
  assert.ok(calls.every((c) => Array.isArray(c.allowed_mentions.parse) && c.allowed_mentions.parse.length === 0));
});

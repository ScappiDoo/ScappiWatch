import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, declare, startRaid, run, goto, endWindow, joinAll, simpleRaidWin } from './helpers.js';
import { replayRaid } from '../src/replay.js';

function fresh(overrides = {}) {
  const env = makeEnv(overrides);
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  const raid = startRaid(env, war);
  return { env, war, raid, warId };
}
const rejected = (env, raid, reason) => env.log.query({ raidId: raid.setup.raidId, type: 'rejected' }).filter((e) => e.data.reason === reason);

test('raider cap is live: raiders may outnumber connected defenders by at most 2', () => {
  const { env, raid } = fresh();
  for (const id of ['s3', 's4', 's5']) raid.enqueue(id, { t: 'sys_disconnect' }, true); // 2 defenders left
  run(env, raid, 1);
  joinAll(env, raid, ['v1', 'v2', 'v3', 'v4', 'v5']);
  assert.equal(raid.counts().raiders, 4);
  assert.equal(rejected(env, raid, 'raider_cap').length, 1);
  // a defender coming back lets the next raider in
  raid.enqueue('s3', { t: 'sys_connect' }, true);
  run(env, raid, 1);
  joinAll(env, raid, ['v5']);
  assert.equal(raid.counts().raiders, 5);
});

test('idle defenders do not count towards the cap', () => {
  const { env, raid } = fresh();
  run(env, raid, 2500); // 125 s with no input: everyone idle
  for (const id of ['s1', 's2']) raid.enqueue(id, { t: 'activity' });
  run(env, raid, 1);
  assert.equal(raid.counts().defenders, 2);
  joinAll(env, raid, ['v1', 'v2', 'v3', 'v4', 'v5']);
  assert.equal(raid.counts().raiders, 4);
});

test('loot is tagged: it cannot be stored and vanishes at the window end', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const c = raid.caches[0];
  goto(env, raid, 'v1', c.x, c.y);
  for (let i = 0; i < 3; i++) raid.enqueue('v1', { t: 'pickup_loot', cache: c.id });
  run(env, raid, 2);
  assert.equal(raid.players.get('v1').carrying, 30);
  // the guard refuses any attempt to store it
  env.world.nation('sax').members.get('s1');
  const tok = env.guard.issueToken('v1');
  env.guard.open('c1', tok);
  for (const [i, t] of ['store_loot', 'deposit', 'trade_loot'].entries()) {
    assert.equal(env.guard.handle('c1', JSON.stringify({ t, seq: i + 1 })).reason, 'banned_action');
  }
  endWindow(env, raid);
  assert.equal(raid.result.lootReturned, 30);
  assert.equal(raid.result.score.attacker, 0);
  assert.equal(raid.caches[0].loot, 60); // back in the cache
  assert.equal(raid.players.get('v1').carrying, 0);
});

test('delivery is blocked while a defender is within 3 tiles of the camp', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1', 's1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const c = raid.caches[0];
  goto(env, raid, 'v1', c.x, c.y);
  raid.enqueue('v1', { t: 'pickup_loot', cache: c.id });
  run(env, raid, 2);
  goto(env, raid, 'v1', 20.5, 45.5, 1);
  goto(env, raid, 's1', 22.5, 45.5, 0.5); // 2 tiles from the camp
  raid.enqueue('v1', { t: 'deliver' });
  run(env, raid, 2);
  assert.equal(rejected(env, raid, 'delivery_blocked').length, 1);
  assert.equal(raid.players.get('v1').carrying, 10);
  assert.equal(raid.score.attacker, 0);
  assert.equal(raid.score.defender, 2);
  goto(env, raid, 's1', 30.5, 45.5, 0.5); // step away: now it works
  raid.enqueue('v1', { t: 'deliver' });
  run(env, raid, 2);
  assert.equal(raid.score.attacker, 10);
});

test('webs and water: 4 tile range, vanish after 10 seconds, only in the zone', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  raid.enqueue('v1', { t: 'place', kind: 'web', x: 24, y: 45 });
  run(env, raid, 1);
  assert.equal(rejected(env, raid, 'outside_zone').length, 1);
  goto(env, raid, 'v1', 34.5, 45.5);
  raid.enqueue('v1', { t: 'place', kind: 'web', x: 40.5, y: 45.5 });
  run(env, raid, 1);
  assert.equal(rejected(env, raid, 'placement_too_far').length, 1);
  raid.enqueue('v1', { t: 'place', kind: 'water', x: 37.5, y: 45.5 });
  run(env, raid, 1);
  assert.equal(raid.placements.length, 1);
  raid.enqueue('v1', { t: 'place', kind: 'lava', x: 36.5, y: 45.5 });
  run(env, raid, 1);
  assert.equal(rejected(env, raid, 'bad_kind').length, 1);
  run(env, raid, 197);
  assert.equal(raid.placements.length, 1); // not yet 10 s
  run(env, raid, 5);
  assert.equal(raid.placements.length, 0);
});

test('teleport, flying, explosives and building damage are refused', () => {
  const { env, raid } = fresh({ guard: { logRejectsPerSecond: 100 } });
  env.guard.open('c1', env.guard.issueToken('v1'));
  const bad = ['teleport', 'ender_pearl', 'fly', 'glide', 'explosive', 'tnt', 'ignite', 'damage_building', 'cargo_boat'];
  bad.forEach((t, i) => assert.equal(env.guard.handle('c1', JSON.stringify({ t, seq: i + 1 })).reason, 'banned_action'));
  // even if one slipped past the guard, the raid itself does not know the action
  raid.enqueue('v1', { t: 'teleport', x: 1, y: 1 });
  run(env, raid, 1);
  assert.equal(rejected(env, raid, 'unknown_action').length, 1);
  assert.equal(env.log.query({ type: 'rejected', actor: 'v1' }).length >= bad.length, true);
});

test('a disconnect in a fight is a defeat and drops the loot', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1', 's1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const c = raid.caches[0];
  goto(env, raid, 'v1', c.x, c.y);
  for (let i = 0; i < 2; i++) raid.enqueue('v1', { t: 'pickup_loot', cache: c.id });
  run(env, raid, 2);
  goto(env, raid, 's1', c.x + 1, c.y, 0.3);
  raid.enqueue('s1', { t: 'attack', target: 'v1' });
  run(env, raid, 1);
  assert.equal(raid.players.get('v1').hp, 75);
  raid.enqueue('v1', { t: 'sys_disconnect' }, true);
  run(env, raid, 1);
  assert.equal(raid.players.get('v1').state, 'dead');
  assert.equal(raid.drops.length, 1);
  assert.equal(raid.drops[0].amount, 20);
  assert.equal(env.log.query({ raidId: raid.setup.raidId, type: 'defeat' }).at(-1).data.cause, 'disconnect_in_fight');
  assert.equal(raid.score.defender, 10);
  assert.ok(env.notes.some((n) => n.k === 'wear' && n.id === 'v1' && n.pct === 0.05));
  // the defender takes the loot back
  goto(env, raid, 's1', raid.drops[0].x, raid.drops[0].y, 0.3);
  raid.enqueue('s1', { t: 'recover_loot', drop: raid.drops[0].id });
  run(env, raid, 1);
  assert.equal(raid.score.defender, 30);
  assert.equal(raid.caches[0].loot, 60);
});

test('same respawn delay for both sides; defenders never respawn near a cache', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1', 's1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  for (const s of raid.spawns) for (const c of raid.caches) assert.ok(Math.hypot(s.x - c.x, s.y - c.y) >= 6);
  for (const id of ['v1', 's1']) raid.defeat(raid.players.get(id), null, 'test');
  const t0 = raid.tick;
  run(env, raid, 399);
  assert.equal(raid.players.get('v1').state, 'dead');
  assert.equal(raid.players.get('s1').state, 'dead');
  run(env, raid, 2);
  assert.equal(raid.players.get('v1').state, 'alive');
  assert.equal(raid.players.get('s1').state, 'alive');
  void t0;
});

test('camp rules: 16+ tiles from caches, not on target land, one camp', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1', 's1']);
  raid.enqueue('s1', { t: 'place_camp', x: 20.5, y: 45.5 });
  raid.enqueue('v1', { t: 'place_camp', x: 38.5, y: 45.5 }); // too close to the caches
  raid.enqueue('v1', { t: 'place_camp', x: 50.5, y: 45.5 }); // on target land
  run(env, raid, 1);
  assert.equal(rejected(env, raid, 'raiders_only').length, 1);
  assert.equal(rejected(env, raid, 'camp_too_close_to_cache').length, 1);
  assert.equal(rejected(env, raid, 'camp_on_owned_land').length, 1);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 1);
  assert.ok(raid.camp);
  raid.enqueue('v1', { t: 'place_camp', x: 21.5, y: 45.5 });
  run(env, raid, 1);
  assert.equal(rejected(env, raid, 'camp_exists').length, 1);
});

test('livestock and horses: caps, theft returns on defeat, held horses score', () => {
  const { env, raid } = fresh({ livestock: { perRaid: 2 }, horses: { perRaid: 2 } });
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const a = raid.animals[0], h = raid.horses[0];
  goto(env, raid, 'v1', a.x, a.y);
  raid.enqueue('v1', { t: 'drive_livestock', animal: a.id });
  run(env, raid, 1);
  assert.equal(a.state, 'driven');
  raid.defeat(raid.players.get('v1'), null, 'test'); // animal goes home
  assert.equal(a.state, 'home');
  run(env, raid, 401);
  goto(env, raid, 'v1', h.x, h.y);
  raid.enqueue('v1', { t: 'claim_horse', horse: h.id });
  run(env, raid, 1);
  assert.equal(h.state, 'ridden');
  goto(env, raid, 'v1', 20.5, 45.5, 1);
  raid.enqueue('v1', { t: 'deliver' });
  run(env, raid, 1);
  assert.equal(h.state, 'held');
  endWindow(env, raid);
  assert.equal(raid.result.score.attacker, 15);
  assert.equal(raid.result.heldHorses.length, 1);
  assert.equal(raid.result.winner, 'attacker');
});

test('horse comes back with its gear if the raiders lose the war, and can be bought back if they win', () => {
  // raiders win -> buy back
  let { env, raid, war, warId } = fresh({ war: { raidsToWin: 1 } });
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const h = raid.horses[0];
  goto(env, raid, 'v1', h.x, h.y);
  raid.enqueue('v1', { t: 'claim_horse', horse: h.id });
  run(env, raid, 1);
  goto(env, raid, 'v1', 20.5, 45.5, 1);
  raid.enqueue('v1', { t: 'deliver' });
  run(env, raid, 1);
  endWindow(env, raid);
  assert.equal(war.result.outcome, 'attacker');
  assert.equal(env.log.query({ warId, type: 'horse_buyback_offer' }).length, 1);
  env.hooks.charge = () => true;
  const owner = war.heldHorses[0].ownerId;
  assert.equal(env.wm.buyBackHorse(warId, h.id, 's9').ok, false);
  assert.equal(env.wm.buyBackHorse(warId, h.id, owner).ok, true);
  // raiders lose -> returned with gear
  ({ env, raid, war, warId } = fresh({ war: { raidsToWin: 2 } }));
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const h2 = raid.horses[0];
  goto(env, raid, 'v1', h2.x, h2.y);
  raid.enqueue('v1', { t: 'claim_horse', horse: h2.id });
  run(env, raid, 1);
  goto(env, raid, 'v1', 20.5, 45.5, 1);
  raid.enqueue('v1', { t: 'deliver' });
  run(env, raid, 1);
  endWindow(env, raid);
  env.wm.surrender(warId, 'attacker', 'v1');
  const back = env.log.query({ warId, type: 'horse_returned' }).at(-1);
  assert.equal(back.data.withGear, true);
  assert.equal(war.result.outcome, 'defender');
});

test('score is capped per raid so one fight cannot decide the war', () => {
  const { env, raid } = fresh({ scoring: { raidScoreCap: 25 } });
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  for (const id of ['c1', 'c2', 'c3']) { const c = raid.caches.find((x) => x.id === id); goto(env, raid, 'v1', c.x, c.y); for (let i = 0; i < 4; i++) raid.enqueue('v1', { t: 'pickup_loot', cache: id }); run(env, raid, 1); goto(env, raid, 'v1', 20.5, 45.5, 1); raid.enqueue('v1', { t: 'deliver' }); run(env, raid, 1); }
  assert.equal(raid.score.attacker, 25);
  assert.ok(env.log.query({ raidId: raid.setup.raidId, type: 'score' }).some((e) => e.data.capped));
});

test('public view never reveals a camp before it exists and flags loot carriers', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1']);
  assert.equal(raid.publicView().camp, null);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const c = raid.caches[0];
  goto(env, raid, 'v1', c.x, c.y);
  raid.enqueue('v1', { t: 'pickup_loot', cache: c.id });
  run(env, raid, 2);
  const v = raid.publicView();
  assert.equal(v.players.find((p) => p.id === 'v1').carrying, true);
  assert.equal(v.caches.find((x) => x.id === c.id).status, 'being_raided');
  assert.ok(!JSON.stringify(v).includes('ip'));
});

test('carrying loot slows the carrier', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  const p = raid.players.get('v1');
  assert.equal(raid.speedFor(p), 4);
  p.carrying = 10;
  assert.ok(Math.abs(raid.speedFor(p) - 3.2) < 1e-9);
});

test('replay of a raid with fights reproduces the exact end state', () => {
  const { env, raid } = fresh();
  simpleRaidWin(env, raid);
  goto(env, raid, 's1', 30.5, 45.5, 0.5);
  raid.enqueue('s1', { t: 'attack', target: 'v1' });
  run(env, raid, 1);
  endWindow(env, raid);
  const rep = replayRaid(env.log, raid.setup.raidId, env.cfg);
  assert.equal(rep.ok, true);
  assert.equal(rep.hash, raid.result.stateHash);
});

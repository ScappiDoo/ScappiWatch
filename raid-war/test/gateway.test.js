import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, declare, startRaid, run, joinAll } from './helpers.js';
import { Gateway } from '../src/gateway.js';
import { DiscordFeed } from '../src/discord.js';
import { publicEvents, publicState } from '../src/public.js';

test('gateway: one connection per account, server-measured ping, input routed to the raid', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const gw = new Gateway({ wm: env.wm, guard: env.guard, detector: env.detector, clock: () => env.clock.t });
  const raid = startRaid(env, env.wm.wars.get(warId));
  for (const id of ['v1', 's1']) env.presence.disconnect(id);
  const tok = env.guard.issueToken('v1');
  assert.equal(gw.connect('a', tok, { ip: '1.1.1.1', device: 'x' }).ok, true);
  assert.equal(gw.connect('b', tok).ok, false); // second tab or device
  assert.equal(gw.connect('c', env.guard.issueToken('s1'), { ip: '2.2.2.2', device: 'y' }).ok, true);
  assert.equal(gw.message('a', JSON.stringify({ t: 'join', seq: 1 })).ok, true);
  assert.equal(gw.message('c', JSON.stringify({ t: 'join', seq: 1 })).ok, true);
  run(env, raid, 1);
  assert.equal(raid.players.get('v1').state, 'staged');
  const [{ msg }] = gw.pings(env.clock.t).filter((p) => p.connId === 'a');
  assert.equal(gw.message('a', JSON.stringify({ t: 'pong', seq: 2, nonce: 'forged' }), env.clock.t + 80).reason, 'bad_pong');
  assert.equal(gw.message('a', JSON.stringify({ t: 'pong', seq: 3, nonce: msg.nonce }), env.clock.t + 80).ok, true);
  run(env, raid, 1);
  assert.equal(raid.players.get('v1').pingMs, 80);
  assert.equal(gw.message('a', JSON.stringify({ t: 'place_camp', seq: 4, x: 20.5, y: 45.5 })).ok, true);
  run(env, raid, 3);
  assert.ok(raid.camp);
  // closing the tab while alive counts as a disconnect
  gw.disconnect('a');
  run(env, raid, 1);
  assert.equal(raid.players.get('v1').connected, false);
  assert.equal(gw.connect('d', tok, {}).ok, true); // can come back
});

test('discord feed uses timestamp tags and stays under 2000 characters', () => {
  const env = makeEnv();
  const sent = [];
  new DiscordFeed({ log: env.log, send: (t) => sent.push(t) });
  const { warId } = declare(env, { reason: 'x'.repeat(400) });
  const war = env.wm.wars.get(warId);
  const raid = startRaid(env, war);
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  env.clock.t = raid.setup.endMs;
  env.wm.tick(env.clock.t);
  assert.ok(sent[0].includes('<t:') && sent[0].includes(':F>'));
  assert.ok(sent.some((m) => m.includes('has begun')) && sent.some((m) => m.includes('is over')));
  assert.ok(sent.every((m) => m.length < 2000));
});

test('spectator data never contains hidden information', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  const raid = startRaid(env, war);
  const before = JSON.stringify(publicState(env.wm));
  assert.ok(!before.includes('"camp":{')); // no landing place before it is used
  joinAll(env, raid, ['v1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  env.detector.flag('hit_validation', 'v1', raid.setup.raidId, { secret: 1 }, env.clock.t);
  const all = JSON.stringify([publicState(env.wm), publicEvents(env.log)]);
  assert.ok(!all.includes('evidence') && !all.includes('10.0.0.') && !all.includes('anticheat') && !all.includes('hit_validation'));
  assert.ok(all.includes('"camp":{'));
});

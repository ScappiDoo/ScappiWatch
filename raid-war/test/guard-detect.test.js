import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, declare, startRaid, run, goto, joinAll } from './helpers.js';

function fresh(overrides = {}) {
  const env = makeEnv(overrides);
  const { warId } = declare(env);
  const raid = startRaid(env, env.wm.wars.get(warId));
  return { env, raid };
}
const open = (env, id = 'v1', conn = 'c1') => env.guard.open(conn, env.guard.issueToken(id), { ip: '1.2.3.4', device: 'dev' });
const send = (env, conn, msg) => env.guard.handle(conn, JSON.stringify(msg));

test('tokens are signed and expire; a second connection for the same account is refused', () => {
  const env = makeEnv();
  const tok = env.guard.issueToken('v1');
  assert.equal(env.guard.open('a', tok).ok, true);
  assert.equal(env.guard.open('b', tok).reason, 'second_connection');
  assert.equal(env.guard.open('c', tok + 'x').reason, 'bad_token');
  assert.equal(env.guard.open('d', 'nope').reason, 'bad_token');
  env.guard.close('a');
  assert.equal(env.guard.open('b', tok).ok, true); // after the first closes it works again
  env.clock.t += 2 * 3600000;
  assert.equal(env.guard.open('e', tok).reason, 'bad_token'); // expired
  assert.ok(env.log.query({ type: 'rejected' }).some((e) => e.data.reason === 'second_connection'));
});

test('message safety: schema, size, sequence numbers and rate', () => {
  const env = makeEnv();
  open(env);
  assert.equal(send(env, 'c1', { t: 'move', seq: 1, dx: 1, dy: 0 }).ok, true);
  assert.equal(send(env, 'c1', { t: 'move', seq: 1, dx: 1, dy: 0 }).reason, 'replayed_or_out_of_order');
  assert.equal(send(env, 'c1', { t: 'move', seq: 0, dx: 1, dy: 0 }).reason, 'replayed_or_out_of_order');
  assert.equal(send(env, 'c1', { t: 'move', seq: 2, dx: 'a', dy: 0 }).reason, 'bad_fields');
  assert.equal(send(env, 'c1', { t: 'move', seq: 3, dx: 1, dy: 0, extra: 1 }).reason, 'bad_fields');
  assert.equal(send(env, 'c1', { t: 'move', seq: 4, dx: 1e9, dy: 0 }).reason, 'bad_fields');
  assert.equal(send(env, 'c1', { t: 'attack', seq: 5, target: 'x'.repeat(200) }).reason, 'bad_fields');
  assert.equal(send(env, 'c1', { t: 'nope', seq: 6 }).reason, 'unknown_type');
  assert.equal(env.guard.handle('c1', 'not json').reason, 'bad_json');
  assert.equal(env.guard.handle('c1', JSON.stringify({ t: 'move', seq: 7, dx: 0, dy: 0, pad: 'x'.repeat(600) })).reason, 'too_large');
  assert.equal(env.guard.handle('zzz', '{}').reason, 'no_session');
  let limited = 0;
  for (let i = 10; i < 200; i++) if (send(env, 'c1', { t: 'activity', seq: i }).reason === 'rate_limited') limited++;
  assert.ok(limited > 100);
  env.clock.t += 2000; // the bucket refills
  assert.equal(send(env, 'c1', { t: 'activity', seq: 500 }).ok, true);
});

test('a modified client that sends fake positions, fake hits or extra messages gains nothing', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1', 's1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  open(env);
  const before = raid.stateHash();
  const attempts = [
    { t: 'set_position', seq: 1, x: 40.5, y: 45.5 },
    { t: 'move', seq: 2, dx: 1, dy: 0, x: 40.5, y: 45.5 }, // smuggled position
    { t: 'hit', seq: 3, target: 's1', damage: 9999 },
    { t: 'claim_hit', seq: 4, target: 's1' },
    { t: 'set_score', seq: 5, side: 'attacker', points: 300 },
    { t: 'sys_score_back', seq: 6, side: 'defender', points: 5 },
  ];
  for (const m of attempts) {
    const r = send(env, 'c1', m);
    if (r.ok) raid.enqueue('v1', r.msg);
  }
  // server-only inputs are refused even if one reaches the raid
  raid.enqueue('v1', { t: 'sys_score_back', side: 'defender', points: 5 });
  raid.enqueue('v1', { t: 'sys_ping', ms: 0 });
  run(env, raid, 1);
  assert.equal(raid.stateHash().length, 64);
  assert.equal(raid.players.get('v1').x, 20.5);
  assert.equal(raid.score.attacker + raid.score.defender, 0);
  assert.equal(raid.players.get('s1').hp, 100);
  assert.notEqual(before, undefined);
  // attacking someone far away is refused whatever the client says
  raid.enqueue('v1', { t: 'attack', target: 's1' });
  run(env, raid, 1);
  assert.equal(raid.players.get('s1').hp, 100);
  assert.equal(raid.players.get('v1').pingMs, 0); // the client cannot set its own ping
});

test('real ping comes from a server nonce, not from the client', () => {
  const env = makeEnv();
  const n = env.detector.newPing('v1', 1000);
  assert.equal(env.detector.pong('v2', n, 1100), null); // someone else's nonce
  assert.equal(env.detector.pong('v1', 'forged', 1100), null);
  assert.equal(env.detector.pong('v1', n, 1120), 120);
  assert.equal(env.detector.pong('v1', n, 1130), null); // single use
});

test('hit rewind accepts a legitimate lagged hit and is capped at 250 ms', () => {
  const { env, raid } = fresh();
  joinAll(env, raid, ['v1', 's1']);
  raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
  run(env, raid, 3);
  goto(env, raid, 'v1', 30.5, 45.5);
  goto(env, raid, 's1', 33.5, 45.5, 0.2); // 3 tiles apart, out of sword reach
  const v = raid.players.get('v1'), s = raid.players.get('s1');
  // s1 ran away 1.2 tiles in the 300 ms before v1's hit landed; v1 (ping 200) saw s1 up close
  raid.enqueue('v1', { t: 'sys_ping', ms: 200 }, true);
  run(env, raid, 1);
  s.history = Array.from({ length: 16 }, (_, i) => ({ x: s.x - Math.min(i + 1, 16) * 0.2, y: s.y }));
  v.x = s.x - 2.3;
  raid.enqueue('v1', { t: 'attack', target: 's1' });
  run(env, raid, 1);
  assert.equal(s.hp, 75); // 4 ticks back: 0.8 tiles behind, reach 2.5 ok
  // a 1000 ms ping does not buy more than 250 ms of rewind
  raid.enqueue('v1', { t: 'sys_ping', ms: 1000 }, true);
  v.attackReadyTick = 0;
  v.x = s.x - 3.9; // would be in reach at 1000 ms back (5.0-... ) but not at the 5-tick cap
  run(env, raid, 1);
  s.history = Array.from({ length: 16 }, (_, i) => ({ x: s.x - (i + 1) * 0.2, y: s.y }));
  raid.enqueue('v1', { t: 'attack', target: 's1' });
  run(env, raid, 1);
  assert.equal(s.hp, 75);
});

test('lag test: legitimate play at 50-200 ms with 7 and 15 percent loss raises no flags', () => {
  for (const ping of [50, 100, 150, 200]) {
    for (const loss of [0.07, 0.15]) {
      const { env, raid } = fresh({ combat: { hp: 1e6 } });
      joinAll(env, raid, ['v1', 's1']);
      raid.enqueue('v1', { t: 'place_camp', x: 20.5, y: 45.5 });
      run(env, raid, 3);
      goto(env, raid, 'v1', 37, 45.5);
      goto(env, raid, 's1', 39, 45.5, 0.3);
      raid.enqueue('v1', { t: 'sys_ping', ms: ping }, true);
      run(env, raid, 1);
      const v = raid.players.get('v1'), s = raid.players.get('s1');
      let seed = ping * 7 + loss * 1000;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      const k = Math.ceil(ping / 50);
      let sent = 0, ok = 0, nextAt = 0;
      for (let t = 0; t < 1400; t++) {
        // s1 shuffles back and forth; v1 stays on it
        const dir = Math.floor(t / 30) % 2 ? -1 : 1;
        raid.enqueue('s1', { t: 'move', dx: dir, dy: 0 });
        const d = Math.hypot(s.x - v.x, s.y - v.y);
        raid.enqueue('v1', { t: 'move', dx: (s.x - v.x) / (d || 1), dy: 0 });
        const seen = raid.rewound(s, k);
        if (t >= nextAt && Math.hypot(seen.x - v.x, seen.y - v.y) <= 1.8) {
          // packet loss shows up as a retransmit: the message lands 1-2 ticks late
          const late = rnd() < loss ? 1 + Math.floor(rnd() * 2) : 0;
          for (let i = 0; i < late; i++) run(env, raid, 1);
          raid.enqueue('v1', { t: 'attack', target: 's1' });
          sent++;
          nextAt = t + 13 + Math.floor(rnd() * 8); // humans do not click on a metronome
        }
        const hp = s.hp;
        run(env, raid, 1);
        if (s.hp < hp) ok++;
      }
      assert.ok(sent > 50 && ok / sent > 0.8, `ping ${ping} loss ${loss}: ${ok}/${sent}`);
      assert.deepEqual(env.detector.open().map((f) => f.kind), [], `flags at ping ${ping} loss ${loss}`);
    }
  }
});

test('hit validation flags only after several gross violations in a row', () => {
  const env = makeEnv();
  const gross = (n) => ({ attacker: 'v1', target: 's1', raidId: 'R1-1', ms: n, gross: true, ok: false, dist: 12, range: 2 });
  for (let i = 0; i < 4; i++) env.detector.onHitCheck(gross(i), i);
  assert.equal(env.detector.open().length, 0);
  env.detector.onHitCheck({ ...gross(5), gross: false, ok: true }, 5); // a legit hit resets the count
  for (let i = 0; i < 4; i++) env.detector.onHitCheck(gross(10 + i), 10 + i);
  assert.equal(env.detector.open().length, 0);
  env.detector.onHitCheck(gross(20), 20);
  assert.equal(env.detector.open().length, 1);
  assert.equal(env.detector.open()[0].kind, 'hit_validation');
});

test('bot signals: perfectly regular timing, inhuman reactions, no breaks', () => {
  const env = makeEnv();
  for (let i = 0; i < 80; i++) env.detector.onInput('botty', 1000 + i * 600, { t: 'attack' }, 'R1');
  assert.ok(env.detector.open().some((f) => f.kind === 'regular_input_timing' && f.accountId === 'botty'));
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let t = 0;
  for (let i = 0; i < 80; i++) { t += 600 + rnd() * 500; env.detector.onInput('human', t, { t: 'attack' }, 'R1'); }
  assert.ok(!env.detector.open().some((f) => f.accountId === 'human'));
  for (let i = 0; i < 5; i++) env.detector.onReaction('aimbot', 40, 'R1', 5000);
  assert.ok(env.detector.open().some((f) => f.kind === 'inhuman_reaction'));
  for (let i = 0; i < 5; i++) env.detector.onReaction('normal', 300 + i * 50, 'R1', 5000);
  assert.ok(!env.detector.open().some((f) => f.accountId === 'normal'));
  for (let ms = 0; ms <= 21 * 60000; ms += 1000) env.detector.onInput('grinder', ms, { t: 'move' }, 'R1');
  assert.ok(env.detector.open().some((f) => f.kind === 'no_breaks'));
});

test('a client that keeps sending refused actions is flagged', () => {
  const env = makeEnv();
  open(env);
  for (let i = 1; i <= 60; i++) send(env, 'c1', { t: i % 2 ? 'teleport' : 'move', seq: i, ...(i % 2 ? {} : { dx: 1, dy: 0 }) });
  assert.ok(env.detector.open().some((f) => f.kind === 'rejected_action_rate' && f.accountId === 'v1'));
});

test('multi-account signals: shared IP, shared device, correlated input timing', () => {
  const env = makeEnv();
  env.detector.registerSession('R1', 'v1', { ip: '9.9.9.9', device: 'd1' });
  env.detector.registerSession('R1', 's1', { ip: '9.9.9.9', device: 'd2' });
  env.detector.registerSession('R1', 'v2', { ip: '1.1.1.1', device: 'd1' });
  for (let i = 0; i < 60; i++) { env.detector.onInput('v3', 1000 + i * 700, { t: 'move' }, 'R1'); env.detector.onInput('v4', 1002 + i * 700, { t: 'move' }, 'R1'); }
  const kinds = env.detector.checkRaid('R1').map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['correlated_input_timing', 'same_device', 'same_ip']);
});

test('evidence buffer keeps 10 seconds and is saved with the flag; staff decide, nothing auto-bans', () => {
  const env = makeEnv();
  for (let ms = 0; ms <= 20000; ms += 100) env.detector.record('v1', ms, 'pos', { x: ms });
  const snap = env.detector.snapshot('v1');
  assert.ok(snap[0].ms >= 10000 && snap.at(-1).ms === 20000);
  const f = env.detector.flag('hit_validation', 'v1', 'R1-1', { n: 5 }, 20000);
  assert.equal(f.evidence.length, snap.length);
  assert.equal(env.log.query({ type: 'anticheat_flag' })[0].data.evidence.length, snap.length);
  assert.equal(env.detector.flag('hit_validation', 'v1', 'R1-1', {}, 21000), null); // de-duplicated
  assert.equal(f.status, 'open');
  for (const m of ['ban', 'kick', 'punish', 'mute']) assert.equal(typeof env.detector[m], 'undefined');
  assert.equal(env.detector.review(f.id, 'staff1', 'confirmed', 'checked replay').ok, true);
  assert.equal(env.log.query({ type: 'anticheat_review' }).length, 1);
});

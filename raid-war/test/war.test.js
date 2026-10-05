import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, declare, startRaid, run, endWindow, simpleRaidWin, GOAL, T0, connectAll } from './helpers.js';
import { replayRaid } from '../src/replay.js';
import { DAY } from '../src/time.js';

const types = (env, warId) => new Set(env.log.query({ warId }).map((e) => e.type));

test('declaration is validated', () => {
  const env = makeEnv();
  assert.equal(declare(env, { byAccount: 'v2' }).reason, 'no_declare_permission');
  assert.equal(declare(env, { reason: '  ' }).reason, 'reason_required');
  assert.equal(declare(env, { goalTiles: ['59,49'] }).reason, 'goal_includes_capital');
  env.world.setAllies('vik', 'sax');
  assert.equal(declare(env).reason, 'allied');
  env.world.nation('vik').allies.clear(); env.world.nation('sax').allies.clear();
  env.world.nation('sax').protectedUntil = T0 + DAY;
  assert.equal(declare(env).reason, 'target_protected');
  env.world.nation('sax').protectedUntil = 0;
  env.world.nation('vik').declareCooldownUntil = T0 + DAY;
  assert.equal(declare(env).reason, 'attacker_cooldown');
  env.world.nation('vik').declareCooldownUntil = 0;
  env.world.addMember('sax', { id: 'v2' });
  assert.equal(declare(env).reason, 'shared_members');
  env.world.nation('sax').members.delete('v2');
  assert.equal(declare(env).ok, true);
  assert.equal(declare(env).reason, 'already_at_war');
  env.world.nation('sax').createdAt = T0 - 1000; // brand-new nations cannot be raided
  assert.equal(env.world.isProtected('sax', T0), true);
  assert.ok(env.log.query({ type: 'declaration_rejected' }).length >= 6);
});

test('attacker is limited to 2 active wars and shielded nations are off limits', () => {
  const env = makeEnv();
  for (const id of ['n1', 'n2', 'n3']) {
    env.world.addNation({ id, tiles: [[100 + id.charCodeAt(1), 5], [101 + id.charCodeAt(1), 5], [102 + id.charCodeAt(1), 5]], capital: [102 + id.charCodeAt(1), 5] });
    env.world.addMember(id, { id: `${id}a` });
  }
  const goalFor = (id) => [`${100 + id.charCodeAt(1)},5`];
  env.world.nation('vik').tiles.add('99,5'); // not needed for adjacency: goal tiles are on the target border
  assert.equal(declare(env, { targetId: 'n1', goalTiles: goalFor('n1') }).ok, true);
  assert.equal(declare(env, { targetId: 'n2', goalTiles: goalFor('n2') }).ok, true);
  assert.equal(declare(env, { targetId: 'n3', goalTiles: goalFor('n3') }).reason, 'attacker_max_wars');
  const e2 = makeEnv();
  assert.equal(e2.wm.setShield('sax', 3, 's1').ok, true);
  assert.equal(declare(e2).reason, 'vacation_shield');
  assert.equal(e2.wm.setShield('sax', 5, 's1').reason, 'shield_budget_exceeded');
});

test('first raid is 24h+ after notice, in the target home window, one raid per day', () => {
  const env = makeEnv({}, { homeWindow: 1 });
  const r = declare(env);
  const war = env.wm.wars.get(r.warId);
  assert.ok(war.slot.startMs >= T0 + 24 * 3600000);
  assert.equal(new Date(war.slot.startMs).toISOString(), '2026-10-06T17:00:00.000Z'); // 19:00 local on the 6th
  assert.ok(env.notes.some((n) => n.k === 'war_declared'));
});

test('home window is locked during a war and changes once a week', () => {
  const env = makeEnv();
  assert.equal(env.wm.setHomeWindow('sax', 2, 's1').ok, true);
  assert.equal(env.wm.setHomeWindow('sax', 1, 's1').reason, 'changed_this_week');
  env.clock.t += 8 * DAY;
  declare(env);
  assert.equal(env.wm.setHomeWindow('sax', 1, 's1').reason, 'locked_during_war');
  assert.equal(env.wm.leaveNation('sax', 's5').reason, 'war_active');
});

test('a full war runs from declaration to land change with a complete, replayable log', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  const raidIds = [];
  for (let day = 0; day < 2; day++) {
    const raid = startRaid(env, war);
    raidIds.push(raid.setup.raidId);
    simpleRaidWin(env, raid);
    assert.equal(raid.score.attacker, 40);
    endWindow(env, raid);
    assert.equal(war.raidId, null);
    if (day === 0) assert.equal(war.status, 'active');
  }
  assert.equal(war.status, 'ended');
  assert.equal(war.result.outcome, 'attacker');
  assert.deepEqual(war.raids.map((r) => r.winner), ['attacker', 'attacker']);
  // land: only the named tiles moved, nothing else
  assert.equal(env.world.nation('vik').tiles.size, 200 + 10);
  assert.ok(GOAL.every((k) => env.world.nation('vik').tiles.has(k) && env.world.owner.get(k) === 'vik'));
  assert.equal(env.world.nation('sax').tiles.size, 190);
  assert.equal(env.world.nation('sax').treasury, 2000);
  assert.equal(env.world.nation('vik').treasury, 1000);
  assert.ok(env.world.nation('sax').protectedUntil > env.clock.t);
  assert.equal(env.world.landGrace[0].until - env.clock.t > 71 * 3600000, true);
  // war goal is fixed: the second raid used the same tiles
  assert.deepEqual(war.goalTiles, GOAL);
  // log has every section-10 event family for this war
  const seen = types(env, warId);
  for (const t of ['war_declared', 'caches_locked', 'raid_start_check', 'raid_start', 'input', 'camp_placed', 'loot_picked_up', 'loot_delivered', 'raid_end', 'raid_result', 'land_change', 'war_ended', 'score']) {
    assert.ok(seen.has(t), `missing ${t}`);
  }
  assert.ok(env.log.verify());
  // replay reproduces each raid
  for (const id of raidIds) {
    const rep = replayRaid(env.log, id, env.cfg);
    assert.equal(rep.ok, true, JSON.stringify(rep));
    assert.equal(rep.winner, 'attacker');
  }
});

test('raid ties go to the defenders, and a war ends on 2 defender wins', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  for (let i = 0; i < 2; i++) {
    const raid = startRaid(env, war);
    run(env, raid, 3);
    endWindow(env, raid);
    assert.equal(raid.result.winner, 'defender'); // 0-0
  }
  assert.equal(war.result.outcome, 'defender');
  assert.equal(env.world.nation('vik').declareCooldownUntil > env.clock.t, true);
  assert.equal(env.world.nation('vik').tiles.size, 200);
  assert.equal(env.wm.declare({ attackerId: 'vik', targetId: 'sax', byAccount: 'v1', reason: 'again', goalTiles: GOAL }, env.clock.t).reason, 'attacker_cooldown');
});

test('defender no-show cancels the raid; two no-shows forfeit the war', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  const s1 = war.slot;
  connectAll(env, s1.startMs - 20 * 60000);
  for (const id of ['s1', 's2', 's3', 's4', 's5']) env.presence.disconnect(id);
  for (const id of ['s1', 's2']) env.presence.connect(id, s1.startMs - 60000);
  for (const id of ['v1', 'v2', 'v3', 'v4', 'v5', 's1', 's2']) env.presence.touch(id, s1.startMs - 10000);
  env.clock.t = s1.startMs; env.wm.tick(env.clock.t);
  assert.equal(war.noShows.defender, 1);
  assert.equal(war.raidId, null);
  assert.equal(env.log.query({ warId, type: 'raid_cancelled' })[0].data.noShow, 'defender');
  assert.equal(war.status, 'active');
  const s2 = war.slot;
  assert.notEqual(s2.day, s1.day);
  connectAll(env, s2.startMs - 20 * 60000);
  for (const id of ['s3', 's4', 's5']) env.presence.disconnect(id);
  for (const id of ['v1', 'v2', 'v3', 's1', 's2']) env.presence.touch(id, s2.startMs - 10000);
  env.clock.t = s2.startMs; env.wm.tick(env.clock.t);
  assert.equal(war.status, 'ended');
  assert.equal(war.result.reason, 'forfeit');
  assert.equal(env.world.nation('vik').tiles.size, 210);
});

test('raider no-show cancels the raid and blocks new declarations for 24h', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  const s = war.slot;
  connectAll(env, s.startMs - 20 * 60000);
  for (const id of ['v1', 'v2', 'v3', 'v4', 'v5']) env.presence.disconnect(id);
  env.presence.connect('v1', s.startMs - 60000);
  for (const id of ['v1', 's1', 's2', 's3', 's4', 's5']) env.presence.touch(id, s.startMs - 10000);
  env.clock.t = s.startMs; env.wm.tick(env.clock.t);
  assert.equal(war.raidId, null);
  assert.equal(war.noShows.attacker, 1);
  assert.equal(env.world.nation('vik').declareCooldownUntil, s.startMs + 24 * 3600000);
});

test('only players connected before the window, active, verified and 7 days in count', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  const s = war.slot;
  connectAll(env, s.startMs - 20 * 60000);
  env.world.member('sax', 's1').joinedAt = s.startMs - 2 * DAY; // too new
  env.world.member('sax', 's2').verified = false;
  env.presence.disconnect('s3'); env.presence.connect('s3', s.startMs + 1000); // connected too late
  for (const id of ['v1', 'v2', 'v3', 'v4', 'v5', 's1', 's2', 's4', 's5']) env.presence.touch(id, s.startMs - 10000);
  env.presence.get('s5').lastInputAt = s.startMs - 300000; // idle 5 minutes
  const def = env.wm.eligible(war, 'defender', s.startMs, s.startMs);
  assert.deepEqual(def.map((d) => d.id), ['s4']);
});

test('surrender, peace, tribute and staff end', () => {
  // defender surrender gives the goal at once
  let env = makeEnv();
  let id = declare(env).warId;
  assert.equal(env.wm.surrender(id, 'defender', 's2').reason, 'no_permission');
  assert.equal(env.wm.surrender(id, 'defender', 's1').ok, true);
  assert.equal(env.world.nation('vik').tiles.size, 210);
  // attacker surrender gives nothing and starts the cooldown
  env = makeEnv();
  id = declare(env).warId;
  env.wm.surrender(id, 'attacker', 'v1');
  assert.equal(env.world.nation('vik').tiles.size, 200);
  assert.ok(env.world.nation('vik').declareCooldownUntil > env.clock.t);
  // peace needs both
  env = makeEnv();
  id = declare(env).warId;
  assert.equal(env.wm.proposePeace(id, 'attacker', 'v1').signed, false);
  assert.equal(env.wm.proposePeace(id, 'defender', 's1').signed, true);
  assert.equal(env.wm.wars.get(id).result.reason, 'peace');
  // tribute is off by default
  env = makeEnv();
  id = declare(env).warId;
  assert.equal(env.wm.offerTribute(id, 's1', 10).reason, 'tribute_disabled');
  // tribute: capped, logged with balances, protects 3 days, no land
  env = makeEnv({ tribute: { enabled: true } });
  id = declare(env).warId;
  assert.equal(env.wm.offerTribute(id, 's1', 101).reason, 'over_tribute_cap');
  assert.equal(env.wm.offerTribute(id, 's1', 100).ok, true);
  assert.equal(env.wm.answerTribute(id, 'v1', true).accepted, true);
  const paid = env.log.query({ type: 'tribute_paid' })[0].data;
  assert.deepEqual(paid.before, { payer: 2000, receiver: 1000 });
  assert.deepEqual(paid.after, { payer: 1900, receiver: 1100 });
  assert.equal(env.world.nation('vik').tiles.size, 200);
  assert.equal(env.wm.declare({ attackerId: 'vik', targetId: 'sax', byAccount: 'v1', reason: 'x', goalTiles: GOAL }, env.clock.t).reason, 'pair_protected');
  // staff end
  env = makeEnv();
  id = declare(env).warId;
  assert.equal(env.staff.end(id, 'player1', 'x').ok, false);
  assert.equal(env.staff.end(id, 'staff1', 'dispute').ok, true);
  assert.equal(env.wm.wars.get(id).result.reason, 'staff');
  assert.equal(env.world.nation('vik').tiles.size, 200);
});

test('war goal can shrink but never grow', () => {
  const env = makeEnv();
  const id = declare(env).warId;
  assert.equal(env.wm.shrinkGoal(id, 'v1', GOAL.slice(0, 4)).ok, true);
  assert.equal(env.wm.shrinkGoal(id, 'v1', GOAL).reason, 'goal_cannot_grow');
  assert.equal(env.wm.shrinkGoal(id, 'v1', ['41,40']).reason, 'goal_cannot_grow');
});

test('undoing a result needs two different staff members and logs the decision', () => {
  const env = makeEnv();
  const id = declare(env).warId;
  env.wm.surrender(id, 'defender', 's1');
  assert.equal(env.staff.undo(id, 'staff1', 'bad call').status, 'needs_second_staff');
  assert.equal(env.staff.undo(id, 'staff1', 'again').reason, 'second_staff_must_differ');
  assert.equal(env.world.nation('vik').tiles.size, 210);
  assert.equal(env.staff.undo(id, 'staff2', 'agree').status, 'undone');
  assert.equal(env.world.nation('vik').tiles.size, 200);
  assert.equal(env.world.nation('sax').tiles.size, 200);
  assert.equal(env.log.query({ type: 'war_result_undone' }).length, 1);
});

test('the log cannot be edited and retention only removes old events', () => {
  const env = makeEnv();
  declare(env);
  const ev = env.log.events[0];
  assert.throws(() => { 'use strict'; ev.type = 'x'; });
  assert.equal(env.log.verify(), true);
  const n = env.log.events.length;
  env.clock.t += 31 * DAY;
  env.log.append('late');
  assert.equal(env.log.prune(env.clock.t), n);
  assert.equal(env.log.verify(), true);
});

test('disputes: ticket within 24h of the raid end, with two-staff undo handled elsewhere', () => {
  const env = makeEnv();
  const { warId } = declare(env);
  const war = env.wm.wars.get(warId);
  const raid = startRaid(env, war);
  const id = raid.setup.raidId;
  assert.equal(env.staff.openTicket({ accountId: 's1', raidId: id, text: 'too early' }).reason, 'raid_not_finished');
  endWindow(env, raid);
  const t = env.staff.openTicket({ accountId: 's1', raidId: id, text: 'unfair' });
  assert.equal(t.ok, true);
  env.clock.t += 25 * 3600000;
  assert.equal(env.staff.openTicket({ accountId: 's2', raidId: id, text: 'late' }).reason, 'dispute_window_closed');
  assert.equal(env.staff.resolveTicket(t.ticket, 'staff1', 'upheld').ok, true);
});

test('allies: at most 2 per side, must be allied to that side, none after a raid starts', () => {
  const env = makeEnv();
  for (const id of ['a1', 'a2', 'a3', 'x1']) {
    env.world.addNation({ id, tiles: [[200 + id.charCodeAt(1), 1]], capital: [200 + id.charCodeAt(1), 1] });
  }
  for (const id of ['a1', 'a2', 'a3']) env.world.setAllies('vik', id);
  env.world.setAllies('sax', 'x1');
  const { warId } = declare(env);
  assert.equal(env.wm.addAlly(warId, 'attacker', 'a1', 'v1').ok, true);
  assert.equal(env.wm.addAlly(warId, 'attacker', 'x1', 'v1').reason, 'not_allied');
  assert.equal(env.wm.addAlly(warId, 'attacker', 'a2', 'v1').ok, true);
  assert.equal(env.wm.addAlly(warId, 'attacker', 'a3', 'v1').reason, 'ally_cap');
  assert.equal(env.wm.addAlly(warId, 'defender', 'x1', 's1').ok, true);
  const raid = startRaid(env, env.wm.wars.get(warId));
  assert.ok(raid);
  assert.equal(env.wm.addAlly(warId, 'defender', 'a1', 's1').reason, 'raid_running');
});

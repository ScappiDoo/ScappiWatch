import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { seedDemoWorld } from '../src/demo-world.js';
import { T0, GOAL } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = { t: T0 };

async function boot(wsOptions = {}) {
  clock.t = T0;
  const app = createApp({ secret: 'test-secret-0123456789', clock: () => clock.t, seedWorld: seedDemoWorld, ws: wsOptions });
  const port = await app.listen(0, '127.0.0.1');
  return { app, port };
}

/** A test client that keeps every message it receives. */
function client(port, { auth, device = 'dev' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { ws, msgs: [], closed: null, seq: 0 };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
  ws.on('close', (code) => { c.closed = code; });
  c.opened = new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m));
  c.act = (m) => c.send({ ...m, seq: ++c.seq });
  c.wait = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = c.msgs.find(pred); if (m) return m; if (c.closed !== null) break; await sleep(10); }
    throw new Error(`timed out; got ${JSON.stringify(c.msgs.slice(-4))} closed=${c.closed}`);
  };
  c.waitClose = async (ms = 2000) => { const end = Date.now() + ms; while (c.closed === null && Date.now() < end) await sleep(10); return c.closed; };
  if (auth !== undefined) c.opened.then(() => c.send({ t: 'auth', token: auth, device }));
  return c;
}
const token = (app, id) => app.guard.issueToken(id, clock.t);

test('auth: bad token, junk first message, timeout and a second connection are all refused', async () => {
  const { app, port } = await boot({ authTimeoutMs: 300 });
  const bad = client(port, { auth: 'nope' });
  assert.equal((await bad.wait((m) => m.t === 'auth_err')).reason, 'bad_token');
  assert.equal(await bad.waitClose(), 4003);

  const junk = client(port);
  await junk.opened; junk.send('hello');
  assert.equal((await junk.wait((m) => m.t === 'auth_err')).reason, 'bad_auth_message');

  const silent = client(port);
  assert.equal(await silent.waitClose(), 4001);

  const tok = token(app, 'v1');
  const a = client(port, { auth: tok });
  await a.wait((m) => m.t === 'welcome');
  const b = client(port, { auth: tok });
  assert.equal((await b.wait((m) => m.t === 'auth_err')).reason, 'second_connection');
  a.ws.close();
  await sleep(50);
  const c = client(port, { auth: tok }); // after the first closed, the account can connect again
  await c.wait((m) => m.t === 'welcome');
  assert.ok(app.ws.stats.authFailures >= 4);
  c.ws.close();
  await app.stop();
});

test('frames: binary, oversized and malformed input are handled without trusting the client', async () => {
  const { app, port } = await boot();
  const a = client(port, { auth: token(app, 'v1') });
  await a.wait((m) => m.t === 'welcome');
  a.act({ t: 'teleport' });
  assert.equal((await a.wait((m) => m.t === 'rej')).reason, 'banned_action');
  a.send('{not json');
  await a.wait((m) => m.t === 'rej' && m.reason === 'bad_json');
  a.act({ t: 'move', dx: 'x', dy: 0 });
  await a.wait((m) => m.t === 'rej' && m.reason === 'bad_fields');
  a.send(JSON.stringify({ t: 'move', seq: 1, dx: 1, dy: 0 })); // replayed sequence number
  await a.wait((m) => m.t === 'rej' && m.reason === 'replayed_or_out_of_order');
  a.act({ t: 'move', dx: 1, dy: 0 }); // fine, but there is no raid yet
  await a.wait((m) => m.t === 'rej' && m.reason === 'no_raid');
  a.send(Buffer.from([1, 2, 3]));
  assert.equal(await a.waitClose(), 1003);

  const b = client(port, { auth: token(app, 'v2') });
  await b.wait((m) => m.t === 'welcome');
  b.send('x'.repeat(5000)); // over the transport limit
  assert.equal(await b.waitClose(), 1009);
  await app.stop();
});

test('a flooding client is cut off and gets no replies to the flood', async () => {
  const { app, port } = await boot();
  const a = client(port, { auth: token(app, 'v1') });
  await a.wait((m) => m.t === 'welcome');
  for (let i = 0; i < 600; i++) a.send(JSON.stringify({ t: 'nope', seq: i + 1 }));
  assert.equal(await a.waitClose(3000), 1008);
  assert.ok(app.ws.stats.closedForFlooding >= 1);
  await app.stop();
});

test('a raid over real sockets: join, state push, server-measured ping, disconnect', async () => {
  const { app, port } = await boot();
  const ids = ['v1', 'v2', 'v3', 's1', 's2', 's3'];
  const war = app.wm.wars.get(app.wm.declare({ attackerId: 'vik', targetId: 'sax', byAccount: 'v1', reason: 'x', goalTiles: GOAL }, clock.t).warId);
  const s = war.slot;
  clock.t = s.startMs - 20 * 60000;
  const cl = Object.fromEntries(ids.map((id) => [id, client(port, { auth: token(app, id) })]));
  for (const id of ids) await cl[id].wait((m) => m.t === 'welcome');
  clock.t = s.startMs - 5 * 60000; app.tick();
  clock.t = s.startMs - 20000;
  for (const id of ids) cl[id].act({ t: 'activity' });
  await sleep(100);
  clock.t = s.startMs; app.tick();
  const raid = app.wm.raids.get(war.raidId);
  assert.ok(raid, 'raid should have started');

  for (const id of ['v1', 's1']) cl[id].act({ t: 'join' });
  await sleep(100);
  clock.t += 50; app.tick();
  cl.v1.act({ t: 'place_camp', x: 20.5, y: 45.5 });
  await sleep(100);
  clock.t += 50; app.tick(); clock.t += 50; app.tick(); clock.t += 50; app.tick();
  app.ws.broadcast();
  const st = await cl.v1.wait((m) => m.t === 'state' && m.camp);
  assert.equal(st.me.side, 'attacker');
  assert.equal(st.me.state, 'alive');
  assert.equal(st.raidId, raid.setup.raidId);
  assert.ok(!JSON.stringify(st).includes('10.0.'));
  // a spectator-safe view: the other side sees the same camp, nobody sees ips
  app.ws.broadcast();
  assert.ok((await cl.s1.wait((m) => m.t === 'state' && m.camp)).camp);

  // ping: the server sends a nonce, the client echoes it, the raid learns the measured ping
  const ping = await cl.v1.wait((m) => m.t === 'ping' || (app.ws.pingNow?.(), false), 100).catch(async () => {
    for (const { connId, msg } of app.gateway.pings(clock.t)) app.ws.clients.get(connId)?.ws.send(JSON.stringify(msg));
    return cl.v1.wait((m) => m.t === 'ping');
  });
  clock.t += 120;
  cl.v1.act({ t: 'pong', nonce: ping.nonce });
  await sleep(100);
  clock.t += 50; app.tick();
  assert.equal(raid.players.get('v1').pingMs, 120);
  // a forged nonce is refused
  cl.v1.act({ t: 'pong', nonce: 'forged' });
  await cl.v1.wait((m) => m.t === 'rej' && m.reason === 'bad_pong');

  // moves reach the sim only as directions; the client cannot move itself anywhere
  const x0 = raid.players.get('v1').x;
  cl.v1.act({ t: 'move', dx: 1, dy: 0 });
  await sleep(100);
  for (let i = 0; i < 20; i++) { clock.t += 50; app.tick(); }
  assert.ok(raid.players.get('v1').x > x0 && raid.players.get('v1').x < x0 + 5);

  // closing the socket is a disconnect inside the raid
  cl.v1.ws.close();
  await sleep(100);
  clock.t += 50; app.tick();
  assert.equal(raid.players.get('v1').connected, false);
  assert.equal(raid.players.get('v1').dx, 0);
  for (const id of ids) cl[id].ws.close();
  await app.stop();
});

test('the same http server answers the spectator routes', async () => {
  const { app, port } = await boot();
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.timezone, 'Europe/Copenhagen');
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /Raid Watch/);
  await app.stop();
});

test('allowed origins: other sites cannot open a socket', async () => {
  const { app, port } = await boot({ allowedOrigins: ['https://game.example'] });
  const open = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
  });
  assert.equal(await open('https://evil.example'), 'refused');
  assert.equal(await open('https://game.example'), 'open');
  await app.stop();
});

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

/**
 * WebSocket transport. All rule decisions stay in Guard and Raid; this layer only
 * authenticates a socket, passes text frames in, and pushes the raid state out.
 *
 *   client -> server   {"t":"auth","token":"...","device":"..."}   first, within authTimeoutMs
 *                      then {"t":"move","seq":1,"dx":1,"dy":0} etc, see guard.js
 *   server -> client   {"t":"welcome"} | {"t":"auth_err","reason"} | {"t":"rej","reason"}
 *                      {"t":"ping","nonce"} (answer with {"t":"pong","seq":n,"nonce"})
 *                      {"t":"state", ...raid public view, "me": {...}}
 */
export function attachWebSocket({
  server, gateway, wm, clock = Date.now, path = '/ws', trustProxy = false,
  authTimeoutMs = 5000, maxPayload = 1024, allowedOrigins = null, pingEveryMs = 2000, heartbeatMs = 15000, maxBuffered = 1 << 20,
}) {
  // Browsers always send Origin. When a list is given, other sites cannot open sockets to us.
  const verifyClient = allowedOrigins ? ({ origin }) => allowedOrigins.includes(origin) : undefined;
  const wss = new WebSocketServer({ server, path, maxPayload, verifyClient });
  const clients = new Map(); // connId -> { ws, accountId }
  const stats = { connections: 0, authFailures: 0, closedForFlooding: 0 };

  const send = (ws, msg) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > maxBuffered) return; // a slow client misses frames instead of growing memory
    ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws, req) => {
    const connId = randomUUID();
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
    let accountId = null, rejectedThisSecond = 0, windowStart = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const authTimer = setTimeout(() => { stats.authFailures++; ws.close(4001, 'auth_timeout'); }, authTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text_only');
      const raw = data.toString();
      if (!accountId) {
        let m;
        try { m = JSON.parse(raw); } catch { m = null; }
        const ok = m && m.t === 'auth' && typeof m.token === 'string' && m.token.length <= 512 && (m.device === undefined || (typeof m.device === 'string' && m.device.length <= 64));
        const r = ok ? gateway.connect(connId, m.token, { ip, device: m.device || '' }, clock()) : { ok: false, reason: 'bad_auth_message' };
        if (!r.ok) {
          stats.authFailures++;
          send(ws, { t: 'auth_err', reason: r.reason });
          return ws.close(4003, r.reason);
        }
        clearTimeout(authTimer);
        accountId = r.accountId;
        clients.set(connId, { ws, accountId });
        stats.connections++;
        return send(ws, { t: 'welcome', accountId, serverMs: clock() });
      }
      const r = gateway.message(connId, raw, clock());
      if (r.ok) return;
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); rejectedThisSecond = 0; }
      if (++rejectedThisSecond > 100) { stats.closedForFlooding++; return ws.close(1008, 'flooding'); }
      if (r.reason !== 'rate_limited') send(ws, { t: 'rej', reason: r.reason }); // never answer a flood
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (accountId) gateway.disconnect(connId);
      clients.delete(connId);
    });
    ws.on('error', () => ws.terminate());
  });

  const pinger = setInterval(() => {
    for (const { connId, msg } of gateway.pings(clock())) send(clients.get(connId)?.ws ?? { readyState: 0 }, msg);
  }, pingEveryMs);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  pinger.unref(); heartbeat.unref();

  /** Push the current raid state to everyone who is in that raid. */
  function broadcast() {
    const views = new Map();
    for (const { ws, accountId } of clients.values()) {
      const raid = wm.raidFor(accountId);
      if (!raid) continue;
      if (!views.has(raid)) views.set(raid, { ...raid.publicView(), t: 'state', serverMs: clock() });
      const p = raid.players.get(accountId);
      send(ws, { ...views.get(raid), me: { id: p.id, side: p.side, state: p.state, hp: p.hp, carrying: p.carrying, pingMs: p.pingMs, connected: p.connected } });
    }
  }

  return {
    wss, clients, stats, broadcast,
    close() {
      clearInterval(pinger); clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

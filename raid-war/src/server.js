import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publicEvents, publicState } from './public.js';

const pagePath = fileURLToPath(new URL('../public/spectator.html', import.meta.url));

/** Read-only spectator routes. Returns { handle(req,res) -> bool, close() }. Public views only. */
export function spectatorRoutes({ wm, log }) {
  const clients = new Set();
  const push = setInterval(() => {
    const data = `data: ${JSON.stringify(publicState(wm))}\n\n`;
    for (const c of clients) c.write(data);
  }, 500);
  push.unref();
  return {
    async handle(req, res) {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await readFile(pagePath));
      } else if (url.pathname === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(publicState(wm)));
      } else if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(publicEvents(log, { sinceSeq: Number(url.searchParams.get('since')) || 0 })));
      } else if (url.pathname === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        res.write(`data: ${JSON.stringify(publicState(wm))}\n\n`);
      } else return false;
      return true;
    },
    close() { clearInterval(push); for (const c of clients) c.end(); },
  };
}

/** Stand-alone spectator server (used by the demo). */
export function createSpectatorServer({ wm, log, port = 8080 }) {
  const routes = spectatorRoutes({ wm, log });
  const server = createServer(async (req, res) => { if (!(await routes.handle(req, res))) res.writeHead(404).end(); });
  return { server, listen: () => new Promise((r) => server.listen(port, r)), close: () => { routes.close(); server.close(); } };
}

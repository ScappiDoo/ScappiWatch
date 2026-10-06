import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publicEvents, publicState } from './public.js';

/** Read-only HTTP server for the spectator page. It exposes public views only. */
export function createSpectatorServer({ wm, log, port = 8080 }) {
  const page = fileURLToPath(new URL('../public/spectator.html', import.meta.url));
  const clients = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(page));
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(publicState(wm)));
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(publicEvents(log, { sinceSeq: Number(url.searchParams.get('since')) || 0 })));
    }
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return res.write(`data: ${JSON.stringify(publicState(wm))}\n\n`);
    }
    res.writeHead(404).end();
  });
  const push = setInterval(() => {
    const data = `data: ${JSON.stringify(publicState(wm))}\n\n`;
    for (const c of clients) c.write(data);
  }, 500);
  push.unref();
  return { server, listen: () => new Promise((r) => server.listen(port, r)), close: () => { clearInterval(push); for (const c of clients) c.end(); server.close(); } };
}

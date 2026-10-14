import { createApp } from './app.js';
import { createWebhookSender } from './discord-webhook.js';
import { seedDemoWorld } from './demo-world.js';

// Environment: TOKEN_SECRET (required), PORT (8080), DB_PATH (raidwar.db),
// ALLOWED_ORIGINS=https://game.example (comma list, optional), DISCORD_WEBHOOK_URL (optional), TRUST_PROXY=1 behind a reverse proxy, STAFF_IDS=a,b (optional).
// --demo seeds two test nations when the database is empty.
const env = process.env;
const staffIds = new Set((env.STAFF_IDS || '').split(',').filter(Boolean));
const app = createApp({
  dbPath: env.DB_PATH || 'raidwar.db',
  secret: env.TOKEN_SECRET,
  trustProxy: env.TRUST_PROXY === '1',
  ws: env.ALLOWED_ORIGINS ? { allowedOrigins: env.ALLOWED_ORIGINS.split(',') } : {},
  isStaff: (id) => staffIds.has(id),
  seedWorld: process.argv.includes('--demo') ? seedDemoWorld : null,
  discordSend: env.DISCORD_WEBHOOK_URL ? createWebhookSender(env.DISCORD_WEBHOOK_URL) : null,
});
const port = await app.listen(Number(env.PORT) || 8080);
app.start();
console.log(`raid-war listening on :${port} (WebSocket /ws, spectator /). ${app.restored ? 'Resumed saved state.' : 'Fresh database.'}`);

const shutdown = async () => { await app.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

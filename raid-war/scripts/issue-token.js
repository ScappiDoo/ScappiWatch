// Mint a session token for testing: TOKEN_SECRET=... node scripts/issue-token.js v1
// In the real game, your login service does this after it has checked the password.
import { Guard } from '../src/guard.js';
import { loadConfig } from '../src/config.js';

const [account] = process.argv.slice(2);
if (!account || !process.env.TOKEN_SECRET) { console.error('usage: TOKEN_SECRET=... node scripts/issue-token.js <accountId>'); process.exit(1); }
console.log(new Guard({ cfg: loadConfig(), secret: process.env.TOKEN_SECRET, log: { append() {} } }).issueToken(account));

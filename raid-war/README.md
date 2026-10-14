# Raid & War System

A fair, lore-based raid and war module for the browser nations game, built from the
"Raid & War System: Build Prompt (HTML Game)". One dependency (`ws`) plus Node's built-in SQLite. Needs Node 22.13 or newer.

```
npm install
npm test                       # 62 tests: rules, raid sim, guard, detection, replay, database, WebSocket
TOKEN_SECRET=<16+ chars> npm start -- --demo   # real server: WebSocket /ws, spectator page /, SQLite file
TOKEN_SECRET=<same> node scripts/issue-token.js v1   # a session token for a test client
node scripts/load.js           # 50 simulated clients through the gateway (DB_PATH=... adds SQLite)
PORT=8080 SPEED=30 node scripts/demo.js   # scripted bots + spectator page on a fast clock, no network clients
```

The client protocol is in `docs/protocol.md`.

## Running it

| Variable | Meaning |
| --- | --- |
| `TOKEN_SECRET` | Required, 16+ characters. Signs session tokens. Your login service mints tokens with the same secret (`Guard.issueToken`) |
| `PORT`, `DB_PATH` | Default `8080` and `raidwar.db` |
| `ALLOWED_ORIGINS` | Comma list. When set, browsers on other sites cannot open the socket |
| `TRUST_PROXY=1` | Use `X-Forwarded-For` for the player's IP (needed for the same-IP signal behind a proxy) |
| `DISCORD_WEBHOOK_URL` | Posts the raid feed; leave unset to turn it off |
| `STAFF_IDS` | Comma list of accounts allowed to use the staff API |
| `--demo` | Seeds two test nations if the database is empty. A real game seeds from its own data instead |

The server speaks plain `ws://`. Put it behind a TLS-terminating proxy (nginx, Caddy) for `wss://`.
Back up the database with SQLite's `.backup` command while it runs, or copy the file when stopped.

## Database and restarts

SQLite via Node's `node:sqlite`. Two things are stored: the **event log** (one row per event, hash chain intact) and a **state snapshot** of nations, wars and tickets, saved whenever something other than raid-floor traffic happens. Events are written in batches every 100 ms inside one transaction, so a crash loses at most the last 100 ms.

On start the server checks the whole hash chain and **refuses to start on a tampered or corrupt log**. A raid that was running is not stored as state: it is rebuilt by replaying its logged inputs, the same replay used for disputes. Then everyone in it is disconnected (logged as `server_restart`), so they reconnect, and anyone caught mid-fight is handled like any other disconnect. The window still ends on schedule. Storage locks are re-asserted. Anti-cheat flags and pending two-person undos are rebuilt from the log. Presence is not saved: after a restart a player must reconnect, and "connected before the window began" counts from that reconnect.

Size: at 50 players sending about 2 messages a second each, a raid logs roughly 6,000 events a minute (about 1.8 MB), so around 160 MB for a full 90 minute window. Retention (30 days) prunes old rows in the database too.

## Design check (deliverable 1)

The prompt asked to confirm the stack first. This repo (`ScappiWatch`) is a Java/Maven
project and has no game in it, so none of the assumed systems exist here. Rather than
guess at your real code, the module talks to the game through small surfaces, and
`src/world.js` is a stand-in for them. Replace it with the real thing:

| Game system | Hook in this module |
| --- | --- |
| Accounts, login | `Guard.issueToken/verifyToken` (HMAC-signed session tokens); `Presence` for who is online |
| Nations, ranks | `World.can(nation, account, 'declare' \| 'surrender' \| 'peace' \| 'tribute')`, `member.verified/joinedAt` |
| Territory | `World.tiles`, `owner`, `transferTiles` (buildings stay, owners get a 72 h grace record) |
| Treasury | `nation.treasury`, tribute and optional silver loot; every tribute logs both balances before and after |
| Alliances | `World.areAllied`, `sharesMembers` |
| Units and gear | `hooks.wear(accountId, 0.05)` on defeat; roster `weapon` |
| Storage lock | `hooks.lockStorage(nationId, bool)`, fired 30 minutes before a window and released after |
| Buy back a horse | `hooks.charge(accountId, price)` |
| Notifications | `hooks.notify(kind, payload)` plus `DiscordFeed`, which subscribes to the log |

## Layout

| File | Role |
| --- | --- |
| `src/config.js` | Every number from section 12. Nothing else hard-codes a rule value |
| `src/time.js` | Windows by IANA zone name, so 25 Oct 2026 is handled; Discord timestamp tags |
| `src/eventlog.js` | Append-only, hash-chained log; no edit API; 30 day retention |
| `src/land.js` | Section 7 war-goal rules |
| `src/war.js` | `WarManager`: declare, validate, notice, schedule, raids, no-shows, surrender, peace, tribute, results, protection |
| `src/raid.js` | One raid as a deterministic 20 Hz simulation (movement, combat, loot, camp, horses, placements, scoring) |
| `src/guard.js` | Raid Guard part 1: exact server-side rules, signed tokens, schema, sequence numbers, rate limits |
| `src/detect.js` | Raid Guard part 2: evidence buffer, ping nonce, hit-validation flags, bot, multi-account and reject-rate signals. Flags only |
| `src/replay.js` | Rebuilds a raid from the log and compares the final state hash |
| `src/staff.js` | Pause, end, score back, two-person undo, dispute tickets. No inventory or log access |
| `src/gateway.js` | Transport-agnostic connection handling |
| `src/ws-server.js` | WebSocket transport: auth, frame limits, flood cut-off, ping/pong, 10 Hz state push |
| `src/db.js`, `src/persist.js` | SQLite event store and the state snapshot |
| `src/app.js`, `src/main.js` | Wires it all together; the real entry point |
| `src/discord.js`, `src/public.js`, `src/server.js`, `public/spectator.html` | Discord feed, safe public data, spectator page with war-map layer and HUD |

## How the fairness rules are enforced

* **Server authority.** Clients send wishes (`move` with a direction, `attack` with a target). The schema has no position, damage or score fields, and extra fields are refused.
* **Same rules both sides.** One weapon table, one respawn delay, one placement rule, for raiders and defenders alike.
* **Deterministic raids.** `Raid` never reads the clock or `Math.random`, and a rejected input never changes state, so the log of accepted inputs replays to the same state hash (tested).
* **No auto-ban.** `Detector` has no punish path: it records a flag with the 10 s evidence buffer and waits for a staff verdict.

## Decisions I made where the prompt was silent

All are config or one-line changes; say if you want any of them different.

* `tribute.enabled` is **false** by default (section 3 says off by default; section 8 describes how it works once on).
* A war stuck on cancelled raids ends with no land change after `war.expireAfterDays` (14).
* If **both** sides miss the minimum, the raid is cancelled and nobody is penalised.
* Camp rule: not on target land or third-party land. Attacker land is allowed. Camps can be outside the zone, since 16 tiles from a cache is further than the 8 tile border.
* Later raids in a war are on later days, in the target's home window, skipping days already used by another war against that target.
* Allies: up to 2 per side, added before a raid starts, must be allied with that side's main nation and not with the other side.
* Loot caches hold 60 points each, a kill is 10 points, a blocked delivery is 2 (rate-limited), per-raid score cap is 300. All guesses to be tuned in the balance test.
* The raid zone is the goal tiles plus 8 tiles in every direction (square, not rounded).
* Optional silver loot mode is a config key but **not implemented**: only `points` works. See "Not done".

## Not done (be aware before launch)

* **No real game client.** The server and protocol are done and tested with scripted clients; the browser client that sends inputs and draws `state` messages is still to build (the spectator page is a starting point for the drawing).
* **No staff HTTP API.** `Staff` and the flag queue work in code (and are restored after a restart), but nothing exposes them to a screen yet. `STAFF_IDS` is wired in but unused until that exists.
* **No login.** The server trusts tokens signed with `TOKEN_SECRET`; your login system must mint them.
* **Staff review screen** (build order step 6): there is no UI and no replay viewer.
* **Silver loot mode** (section 6 optional) and **capital-in-war-goal** question are left out. Capture of players is left out on purpose, as the prompt says.
* **Balance test, real lag test and a load test over real sockets** need people and real networks. `scripts/load.js` drives the gateway in-process. See `docs/test-report.md` for exactly what was and was not covered.
* The line-of-sight and movement collision use a blocked-tile set; plug in your real terrain.

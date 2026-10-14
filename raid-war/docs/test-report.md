# Test report (section 13)

Run: `npm test` (62 tests, all passing) and `node scripts/load.js`.
"Automated" means covered by a test in `test/`. Items that need real players or networks are marked as such.

| Section 13 item | Result | Where |
| --- | --- | --- |
| Full war from declaration to land change with a complete log | Pass | `war.test.js` "a full war runs…": two raids, land moves, treasury untouched, log chain verified, every raid replayed |
| Defender no-show cancels the raid; two forfeit | Pass | `war.test.js` "defender no-show…" |
| Raiders cannot exceed connected defenders by more than 2 (incl. idle) | Pass | `raid.test.js` "raider cap is live", "idle defenders…". Alt accounts: flagged by `detector.checkRaid` (`guard-detect.test.js`) |
| Second tab or device refused | Pass | `guard-detect.test.js`, `gateway.test.js` |
| Loot cannot be stored and vanishes at the window end | Pass | `raid.test.js` "loot is tagged…" |
| Delivery blocked within 3 tiles of the camp | Pass | `raid.test.js` "delivery is blocked…" |
| Horse returns with gear if raiders lose; bought back if they win | Pass | `raid.test.js` "horse comes back…" (buy-back price charged via `hooks.charge`) |
| Webs and water beyond 4 tiles refused; vanish after 10 s | Pass | `raid.test.js` "webs and water…" |
| Teleport, flying, explosives refused | Pass | `raid.test.js` "teleport, flying…" |
| Disconnect in a fight counts as defeat and drops loot | Pass | `raid.test.js` "a disconnect in a fight…" |
| Modified client (fake positions, hits, extra messages) gains nothing | Pass | `guard-detect.test.js` "a modified client…" |
| War ends correctly on tie, surrender, tribute, staff end | Pass | `war.test.js` "raid ties…", "surrender, peace, tribute and staff end" |
| Window times correct across 25 October 2026 | Pass | `time-land.test.js` (UTC+2 to UTC+1) |
| War map layer and Discord feed match real state | Partly | Both are built from the same log and `publicView()`; `gateway.test.js` checks feed text and that the spectator data has no hidden fields. The map was only checked by eye in a screenshot of the demo, not with an automated visual test |
| Every section 10 item is logged and a raid can be replayed | Pass for what exists | Event families are asserted in `war.test.js`; replay hash match in `war.test.js` and `raid.test.js`. Wear on defeat goes to `hooks.wear`, which is logged by the game side |

## Lag test
`guard-detect.test.js` "lag test": pings 50, 100, 150, 200 ms x 7% and 15% loss, 1400 ticks each,
a chasing attacker against a target that reverses direction. More than 80% of attempts land and **no flags are raised**.
*Limit:* this is a simulation of delay and retransmits inside the sim, not a real network. Re-run on a real link before launch.
While writing it the detector correctly flagged a perfectly regular click rhythm, so the test attacker uses jittered timing.

## Load test
`node scripts/load.js`: 50 clients (25 per side), 12,000 ticks (10 minutes), all sending through the real guard.
Result on this machine (in memory, about 2 messages a second per client): **about 0.4 ms average per tick against a 50 ms budget**, 0 flags.
*Limit:* in-memory here; the database figure is below.

## Database and WebSocket (added after the first version)
| Check | Where |
| --- | --- |
| Events and state survive a restart; chain verified on load | `persist.test.js` |
| A tampered database is refused at start | `persist.test.js` |
| A running raid is rebuilt from the log, everyone is disconnected, the window ends on time, the resumed raid still replays | `persist.test.js` |
| Storage locks re-asserted; retention prune survives a restart; flags, undo proposals and tickets restored | `persist.test.js` |
| Auth refused for bad token, junk, timeout, second connection; binary, oversized, malformed and flooding frames handled; origin check | `ws.test.js` |
| A raid over real sockets: join, camp, state push to both sides, server-measured ping, forged nonce refused, move is a direction only, closing the socket is a disconnect | `ws.test.js` |
| Real process: start, connect, restart on the same file reports "Resumed saved state" | run by hand, not automated |

Load with SQLite (`DB_PATH=... node scripts/load.js`), 50 clients, 10 minutes:
about 2 messages/s each: **0.39 ms average, 19 ms worst** per tick, 18 MB written;
5 messages/s each: **0.86 ms average, 30 ms worst**, 90 MB. The worst case is a batch write, so it is the number to watch against the 50 ms budget.
*Limit:* in-process, not over sockets, and on this machine's disk.

## Not run
* **Balance test** (10+ raids with real players, raiders winning 40-60%): needs players. The scoring numbers are untuned starting points.
* **Anticheat launch rule** (flags alert staff only for 2 weeks): there is no punishment path at all; `antiCheat.alertOnlyUntil` only marks flags raised in that period.

# Test report (section 13)

Run: `npm test` (49 tests, all passing) and `node scripts/load.js`.
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
Result on this machine: **0.39 ms average per tick, 12.8 ms worst, against a 50 ms budget**, 0 flags.
*Limit:* in-memory, no network or database cost.

## Not run
* **Balance test** (10+ raids with real players, raiders winning 40-60%): needs players. The scoring numbers are untuned starting points.
* **Anticheat launch rule** (flags alert staff only for 2 weeks): there is no punishment path at all; `antiCheat.alertOnlyUntil` only marks flags raised in that period.

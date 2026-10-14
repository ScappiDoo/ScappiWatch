# Client protocol (WebSocket, JSON text frames)

Connect to `ws(s)://host/ws`. Frames must be text and at most 1024 bytes (the guard allows 512 for game messages). The client sends wishes, never state: there is no field for a position, damage, hit or score.

## Handshake
1. Send `{"t":"auth","token":"<signed token>","device":"<stable id, optional>"}` within 5 seconds.
2. Reply `{"t":"welcome","accountId":"v1","serverMs":...}`, or `{"t":"auth_err","reason":"bad_token|second_connection|bad_auth_message"}` and the socket closes (code 4003; 4001 on timeout). One connection per account.

## Client messages
Every message after auth carries `"seq"`: an integer that must be higher than the last one sent. Extra or missing fields are refused.

| `t` | Fields | Meaning |
| --- | --- | --- |
| `join` | none | Enter the raid you are eligible for |
| `leave` | none | Leave it (drops loot) |
| `activity` | none | Keeps you from counting as idle |
| `move` | `dx`, `dy` | A direction (length is clamped to 1). The server moves you |
| `attack` | `target` | Account id. Range, cooldown and line of sight are checked on the server |
| `place` | `kind` (`web`\|`water`), `x`, `y` | Within 4 tiles and line of sight; gone after 10 s |
| `place_camp` | `x`, `y` | Raiders only, once |
| `pickup_loot` | `cache` | Raiders, within 2 tiles |
| `recover_loot` | `drop` | Defenders |
| `deliver` | none | At the camp, with no defender within 3 tiles |
| `claim_horse`, `drive_livestock` | `horse` / `animal` | Raiders |
| `pong` | `nonce` | Answer to a server `ping` |

Teleporting, flying, storing loot, explosives, fire and damaging buildings are not messages at all: sending one is answered with `banned_action` and logged.

## Server messages
* `{"t":"rej","reason":"..."}`: the guard or the raid refused a message. Never sent for `rate_limited`.
* `{"t":"ping","nonce":"..."}`: reply at once with `{"t":"pong","seq":n,"nonce":"..."}`. The server measures your ping from this; a value you send yourself is never used.
* `{"t":"state", ...}` about 10 times a second while you are in a raid: `raidId`, `msLeft`, `score`, `stats`, `goalTiles`, `zoneTiles`, `caches` (with status), `camp` (once placed), `players` (position, side, whether carrying loot), `placements`, `serverMs`, and `me` (your side, state, hp, carrying, measured ping).

A client that is rejected more than 100 times in a second is disconnected (close code 1008).

# ScappiWatch

Discord audit and alerts for Paper servers. Paste one webhook URL and get clean embeds for joins, quits, first joins, deaths, staff command usage, TPS drops, main-thread stalls and server start/stop — no bot token required. Other Scappi plugins push their events (bans, freeze-logouts...) through the same pipe.

## Features

- **Webhook-only mode**: zero setup beyond a webhook URL. Joins / quits / first joins, deaths with coordinates, watched command usage, TPS threshold + recovery alerts, watchdog stall alerts (sent from a separate thread, so they escape a frozen server), server start/stop.
- **Per-alert channel routing**: give any alert key its own webhook (its own Discord channel); everything else falls back to the default.
- **Rate limiting + batching**: max N alerts per key per minute, floods collapse into a "N suppressed" footer; up to 10 embeds ride one HTTP request.
- **Digest mode**: buffer chatty keys (joins/quits/deaths) into one hourly or daily summary embed.
- **Anomaly alerts**: join bursts (N brand-new accounts in M minutes) and logins from a never-before-seen country per account (optional geo-IP lookup, embedded H2 persistence).
- **Optional bot mode** (JDA, connects off the main thread): `/online`, `/tps`, `/whereis <player>` slash commands in Discord.
- **Public API**: other plugins call `ScappiWatchAPI.emit(AlertEvent)` — safe no-op when ScappiWatch is absent.

## Requirements

- **Paper** 1.21.8+
- **Java 21**
- Internet access on first boot (runtime libraries are downloaded via Paper's library loader)

## Building

```bash
mvn clean package
```

Output: `target/ScappiWatch.jar` → drop into `plugins/` and restart.

## Commands

| Command | Aliases | Permission | Description |
|---|---|---|---|
| `/scappiwatch reload` | `sw`, `watch` | `scappiwatch.admin` | Reload the configuration |
| `/scappiwatch test` | `sw`, `watch` | `scappiwatch.admin` | Send a test alert to Discord |

## Permissions

| Permission | Default | Description |
|---|---|---|
| `scappiwatch.admin` | op | Allows `/scappiwatch` |

## Configuration

`config.yml` controls the default webhook URL, per-alert channel overrides, which alerts are on, the watched command list, TPS/watchdog thresholds, anomaly detection, rate limits, digest mode and bot mode. Every key is commented in the file.

## API for other plugins

```java
ScappiWatchAPI.emit(AlertEvent.builder("punish.ban", "Player banned")
        .color(AlertEvent.RED)
        .field("Player", target)
        .field("Reason", reason)
        .build());
```

Route the whole `punish` family to its own channel via `webhook.channels.punish`.

## License

[MIT](LICENSE) © 2026 Scappi

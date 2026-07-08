package dev.scappi.scappiwatch.alert;

import dev.scappi.core.discord.Embed;
import dev.scappi.core.discord.WebhookClient;
import dev.scappi.scappiwatch.api.AlertEvent;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.FileConfiguration;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;

/**
 * Routes alerts to webhook channels. One {@link WebhookClient} per distinct
 * URL (batching stays shared), per-alert-key overrides fall back to the
 * default URL, and a per-key per-minute throttle collapses floods into a
 * single "N suppressed" notice. Keys listed under {@code digest.include} are
 * buffered into the digest instead of sent live.
 */
public final class AlertRouter {

    private final Logger logger;
    private final Map<String, WebhookClient> clientsByUrl = new HashMap<>();
    private final Map<String, String> channelOverrides = new HashMap<>();
    private final String defaultUrl;
    private final int maxPerMinute;
    private final Set<String> digestKeys = new HashSet<>();
    private final DigestBuffer digest;

    private final Map<String, Window> windows = new ConcurrentHashMap<>();
    private boolean warnedMissingUrl;

    public AlertRouter(FileConfiguration config, Logger logger) {
        this.logger = logger;
        this.defaultUrl = config.getString("webhook.default-url", "");
        this.maxPerMinute = Math.max(1, config.getInt("rate-limit.per-alert-per-minute", 20));

        ConfigurationSection channels = config.getConfigurationSection("webhook.channels");
        if (channels != null) {
            for (String key : channels.getKeys(false)) {
                String url = channels.getString(key, "");
                if (!url.isBlank()) channelOverrides.put(key, url);
            }
        }

        if (config.getBoolean("digest.enabled", false)) {
            digestKeys.addAll(config.getStringList("digest.include"));
            this.digest = new DigestBuffer(
                    client(channelOverrides.getOrDefault("digest", defaultUrl)),
                    "daily".equalsIgnoreCase(config.getString("digest.interval", "hourly")));
        } else {
            this.digest = null;
        }
    }

    /** Thread-safe; callable from any thread including the webhook worker. */
    public void emit(AlertEvent event) {
        if (digest != null && digestKeys.contains(event.key())) {
            digest.add(event);
            return;
        }

        String url = channelOverrides.getOrDefault(event.key(), defaultUrl);
        // Sub-keys like "punish.ban" fall back to their family override ("punish").
        if (url.isBlank() || url.equals(defaultUrl)) {
            int dot = event.key().indexOf('.');
            if (dot > 0) url = channelOverrides.getOrDefault(event.key().substring(0, dot), url);
        }
        if (url.isBlank()) {
            if (!warnedMissingUrl) {
                warnedMissingUrl = true;
                logger.warning("No webhook URL configured (webhook.default-url) - alerts are dropped.");
            }
            return;
        }

        int suppressed = throttle(event.key());
        if (suppressed < 0) return; // still inside a suppressed window

        Embed embed = toEmbed(event);
        if (suppressed > 0) {
            embed.footer(suppressed + " earlier '" + event.key() + "' alerts were rate-limited");
        }
        client(url).send(embed);
    }

    public void flushAndShutdown() {
        if (digest != null) digest.flushAndShutdown();
        clientsByUrl.values().forEach(WebhookClient::shutdown);
    }

    private WebhookClient client(String url) {
        return clientsByUrl.computeIfAbsent(url, u -> new WebhookClient(u, logger));
    }

    /**
     * @return 0 to send normally, a positive count of newly released suppressed
     * alerts, or -1 when this alert must be dropped.
     */
    private int throttle(String key) {
        Window window = windows.computeIfAbsent(key, k -> new Window());
        long minute = System.currentTimeMillis() / 60_000L;
        synchronized (window) {
            if (window.minute != minute) {
                int suppressed = window.suppressed;
                window.minute = minute;
                window.count = 1;
                window.suppressed = 0;
                return suppressed;
            }
            if (window.count >= maxPerMinute) {
                window.suppressed++;
                return -1;
            }
            window.count++;
            return 0;
        }
    }

    static Embed toEmbed(AlertEvent event) {
        Embed embed = new Embed()
                .title(event.title())
                .color(event.color())
                .timestamp(event.timestamp());
        if (event.description() != null) embed.description(event.description());
        event.fields().forEach((name, value) -> embed.field(name, value, true));
        return embed;
    }

    private static final class Window {
        long minute;
        int count;
        int suppressed;
    }
}

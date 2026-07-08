package dev.scappi.scappiwatch.anomaly;

import dev.scappi.scappiwatch.ScappiWatch;
import dev.scappi.scappiwatch.api.AlertEvent;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Flags registration waves: N brand-new accounts inside an M-minute window
 * usually means a bot raid or an alt flood.
 */
public final class JoinBurstDetector {

    private final ScappiWatch plugin;
    private final boolean enabled;
    private final int accounts;
    private final long windowMillis;
    private final Deque<Long> firstJoins = new ArrayDeque<>();
    private long lastAlert;

    public JoinBurstDetector(ScappiWatch plugin) {
        this.plugin = plugin;
        this.enabled = plugin.getConfig().getBoolean("anomaly.join-burst.enabled", true);
        this.accounts = Math.max(2, plugin.getConfig().getInt("anomaly.join-burst.accounts", 5));
        this.windowMillis = Math.max(1, plugin.getConfig().getInt("anomaly.join-burst.window-minutes", 10)) * 60_000L;
    }

    public synchronized void recordFirstJoin() {
        if (!enabled) return;
        long now = System.currentTimeMillis();
        firstJoins.addLast(now);
        while (!firstJoins.isEmpty() && now - firstJoins.peekFirst() > windowMillis) {
            firstJoins.removeFirst();
        }
        if (firstJoins.size() >= accounts && now - lastAlert > windowMillis) {
            lastAlert = now;
            plugin.emit(AlertEvent.builder("anomaly", "Join burst detected")
                    .color(AlertEvent.RED)
                    .description(firstJoins.size() + " brand-new accounts joined within "
                            + (windowMillis / 60_000) + " minutes.")
                    .build());
        }
    }
}

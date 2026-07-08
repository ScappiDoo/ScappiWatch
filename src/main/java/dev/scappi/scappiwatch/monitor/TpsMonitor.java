package dev.scappi.scappiwatch.monitor;

import dev.scappi.scappiwatch.ScappiWatch;
import dev.scappi.scappiwatch.api.AlertEvent;
import org.bukkit.Bukkit;
import org.bukkit.scheduler.BukkitTask;

/**
 * Polls Paper's rolling TPS every 30 seconds. Alerts when the 1-minute average
 * drops below the threshold, then again when it recovers; a cooldown stops a
 * hovering TPS from flapping alerts.
 */
public final class TpsMonitor {

    private final ScappiWatch plugin;
    private final double threshold;
    private final long cooldownMillis;
    private BukkitTask task;
    private long lastAlert;
    private boolean degraded;

    public TpsMonitor(ScappiWatch plugin) {
        this.plugin = plugin;
        this.threshold = plugin.getConfig().getDouble("alerts.tps.threshold", 15.0);
        this.cooldownMillis = plugin.getConfig().getLong("alerts.tps.cooldown-seconds", 300) * 1000L;
    }

    public void start() {
        if (!plugin.getConfig().getBoolean("alerts.tps.enabled", true)) return;
        task = Bukkit.getScheduler().runTaskTimer(plugin, this::check, 20L * 60, 20L * 30);
    }

    public void stop() {
        if (task != null) task.cancel();
    }

    private void check() {
        double tps = Bukkit.getTPS()[0];

        if (tps < threshold && !degraded) {
            if (System.currentTimeMillis() - lastAlert < cooldownMillis) return;
            degraded = true;
            lastAlert = System.currentTimeMillis();
            plugin.emit(AlertEvent.builder("tps", "TPS dropped below " + threshold)
                    .color(AlertEvent.RED)
                    .field("TPS (1m)", String.format("%.2f", tps))
                    .field("Players", String.valueOf(Bukkit.getOnlinePlayers().size()))
                    .build());
        } else if (tps >= threshold && degraded) {
            degraded = false;
            plugin.emit(AlertEvent.builder("tps", "TPS recovered")
                    .color(AlertEvent.GREEN)
                    .field("TPS (1m)", String.format("%.2f", tps))
                    .build());
        }
    }
}

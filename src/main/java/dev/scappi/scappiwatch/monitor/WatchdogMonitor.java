package dev.scappi.scappiwatch.monitor;

import dev.scappi.scappiwatch.ScappiWatch;
import dev.scappi.scappiwatch.api.AlertEvent;
import org.bukkit.Bukkit;
import org.bukkit.scheduler.BukkitTask;

/**
 * Detects main-thread stalls. A sync task bumps a heartbeat every tick; a
 * daemon thread watches the gap. Because the webhook client runs on its own
 * thread, the alert can leave the box even while the server is frozen.
 */
public final class WatchdogMonitor {

    private final ScappiWatch plugin;
    private final long stallMillis;
    private volatile long lastTick = System.currentTimeMillis();
    private volatile boolean running;
    private BukkitTask heartbeatTask;
    private Thread watcher;

    public WatchdogMonitor(ScappiWatch plugin) {
        this.plugin = plugin;
        this.stallMillis = Math.max(2, plugin.getConfig().getLong("alerts.watchdog.stall-seconds", 10)) * 1000L;
    }

    public void start() {
        if (!plugin.getConfig().getBoolean("alerts.watchdog.enabled", true)) return;
        running = true;
        heartbeatTask = Bukkit.getScheduler().runTaskTimer(plugin,
                () -> lastTick = System.currentTimeMillis(), 1L, 1L);

        watcher = new Thread(this::watch, "scappi-watchdog");
        watcher.setDaemon(true);
        watcher.start();
    }

    public void stop() {
        running = false;
        if (heartbeatTask != null) heartbeatTask.cancel();
        if (watcher != null) watcher.interrupt();
    }

    private void watch() {
        boolean alerted = false;
        while (running) {
            try {
                Thread.sleep(1000);
            } catch (InterruptedException e) {
                return;
            }
            long gap = System.currentTimeMillis() - lastTick;
            if (gap >= stallMillis && !alerted) {
                alerted = true;
                plugin.emit(AlertEvent.builder("watchdog", "Server main thread stalled")
                        .color(AlertEvent.RED)
                        .field("Stalled for", (gap / 1000) + "s (and counting)")
                        .build());
            } else if (gap < stallMillis && alerted) {
                alerted = false;
                plugin.emit(AlertEvent.builder("watchdog", "Server recovered from stall")
                        .color(AlertEvent.GREEN)
                        .build());
            }
        }
    }
}

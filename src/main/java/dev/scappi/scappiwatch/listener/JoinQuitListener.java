package dev.scappi.scappiwatch.listener;

import dev.scappi.scappiwatch.ScappiWatch;
import dev.scappi.scappiwatch.api.AlertEvent;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

public final class JoinQuitListener implements Listener {

    private final ScappiWatch plugin;

    public JoinQuitListener(ScappiWatch plugin) {
        this.plugin = plugin;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        boolean firstJoin = !player.hasPlayedBefore();

        if (firstJoin && plugin.alertEnabled("first-joins")) {
            plugin.emit(AlertEvent.builder("first-joins", "First join: " + player.getName())
                    .color(AlertEvent.BLURPLE)
                    .field("Player", player.getName())
                    .field("Online", online())
                    .build());
        } else if (plugin.alertEnabled("joins")) {
            plugin.emit(AlertEvent.builder("joins", player.getName() + " joined")
                    .color(AlertEvent.GREEN)
                    .field("Online", online())
                    .build());
        }

        if (firstJoin) plugin.joinBurstDetector().recordFirstJoin();
        plugin.ipCountryTracker().checkAsync(player);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        if (!plugin.alertEnabled("quits")) return;
        plugin.emit(AlertEvent.builder("quits", event.getPlayer().getName() + " left")
                .color(AlertEvent.GRAY)
                .field("Online", String.valueOf(Bukkit.getOnlinePlayers().size() - 1))
                .build());
    }

    private static String online() {
        return Bukkit.getOnlinePlayers().size() + "/" + Bukkit.getMaxPlayers();
    }
}

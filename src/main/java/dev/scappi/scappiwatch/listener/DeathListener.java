package dev.scappi.scappiwatch.listener;

import dev.scappi.core.config.Text;
import dev.scappi.scappiwatch.ScappiWatch;
import dev.scappi.scappiwatch.api.AlertEvent;
import net.kyori.adventure.text.Component;
import org.bukkit.Location;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.PlayerDeathEvent;

public final class DeathListener implements Listener {

    private final ScappiWatch plugin;

    public DeathListener(ScappiWatch plugin) {
        this.plugin = plugin;
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(PlayerDeathEvent event) {
        if (!plugin.alertEnabled("deaths")) return;

        Component message = event.deathMessage();
        Location location = event.getPlayer().getLocation();
        plugin.emit(AlertEvent.builder("deaths",
                        message != null ? Text.plain(message) : event.getPlayer().getName() + " died")
                .color(AlertEvent.ORANGE)
                .field("World", location.getWorld().getName())
                .field("Location", location.getBlockX() + ", " + location.getBlockY()
                        + ", " + location.getBlockZ())
                .build());
    }
}

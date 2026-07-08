package dev.scappi.scappiwatch.listener;

import dev.scappi.scappiwatch.ScappiWatch;
import dev.scappi.scappiwatch.api.AlertEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;

import java.util.List;
import java.util.Locale;

/** Reports usage of watched (typically staff/danger) commands. */
public final class CommandListener implements Listener {

    private final ScappiWatch plugin;
    private final List<String> watched;

    public CommandListener(ScappiWatch plugin) {
        this.plugin = plugin;
        this.watched = plugin.getConfig().getStringList("alerts.commands.watched").stream()
                .map(entry -> entry.toLowerCase(Locale.ROOT))
                .map(entry -> entry.startsWith("/") ? entry : "/" + entry)
                .toList();
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onCommand(PlayerCommandPreprocessEvent event) {
        if (!plugin.getConfig().getBoolean("alerts.commands.enabled", true)) return;

        String message = event.getMessage().toLowerCase(Locale.ROOT);
        String label = message.split(" ", 2)[0];
        boolean match = watched.stream().anyMatch(label::equals);
        if (!match) return;

        plugin.emit(AlertEvent.builder("commands", "Watched command used")
                .color(AlertEvent.YELLOW)
                .field("Player", event.getPlayer().getName())
                .field("Command", event.getMessage())
                .build());
    }
}

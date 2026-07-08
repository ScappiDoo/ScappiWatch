package dev.scappi.scappiwatch;

import dev.scappi.core.config.Text;
import dev.scappi.scappiwatch.api.AlertEvent;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.jetbrains.annotations.NotNull;

import java.util.List;

public final class WatchCommand implements CommandExecutor, TabCompleter {

    private final ScappiWatch plugin;

    public WatchCommand(ScappiWatch plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(@NotNull CommandSender sender, @NotNull Command command,
                             @NotNull String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage(Text.mm("<gray>[<aqua>ScappiWatch</aqua>] /" + label + " reload | test"));
            return true;
        }
        switch (args[0].toLowerCase()) {
            case "reload" -> {
                plugin.reload();
                sender.sendMessage(Text.mm("<gray>[<aqua>ScappiWatch</aqua>] <green>Configuration reloaded."));
            }
            case "test" -> {
                plugin.emit(AlertEvent.builder("test", "Test alert")
                        .color(AlertEvent.GREEN)
                        .description("If you can read this, ScappiWatch is wired up correctly.")
                        .field("Sent by", sender.getName())
                        .build());
                sender.sendMessage(Text.mm("<gray>[<aqua>ScappiWatch</aqua>] <green>Test alert queued."));
            }
            default -> sender.sendMessage(Text.mm("<gray>[<aqua>ScappiWatch</aqua>] <red>Unknown subcommand."));
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(@NotNull CommandSender sender, @NotNull Command command,
                                      @NotNull String alias, String[] args) {
        return args.length == 1 ? List.of("reload", "test") : List.of();
    }
}

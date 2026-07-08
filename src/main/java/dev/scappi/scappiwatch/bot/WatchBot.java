package dev.scappi.scappiwatch.bot;

import dev.scappi.scappiwatch.ScappiWatch;
import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.JDABuilder;
import net.dv8tion.jda.api.events.interaction.command.SlashCommandInteractionEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import net.dv8tion.jda.api.interactions.commands.OptionType;
import net.dv8tion.jda.api.interactions.commands.build.Commands;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;

import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

/**
 * Optional bot mode. Connects OFF the main server thread (same pattern as
 * ScappiSupport) so a slow or failed Discord login can never block startup.
 * Provides /online, /tps and /whereis slash commands.
 */
public final class WatchBot extends ListenerAdapter {

    private final ScappiWatch plugin;
    private volatile JDA jda;

    public WatchBot(ScappiWatch plugin, String token) {
        this.plugin = plugin;
        CompletableFuture.runAsync(() -> {
            try {
                JDA built = JDABuilder.createLight(token)
                        .addEventListeners(this)
                        .build();
                built.awaitReady();
                built.updateCommands().addCommands(
                        Commands.slash("online", "List online players"),
                        Commands.slash("tps", "Show current server TPS"),
                        Commands.slash("whereis", "Locate an online player")
                                .addOption(OptionType.STRING, "player", "Player name", true)
                ).queue();
                this.jda = built;
                plugin.getLogger().info("ScappiWatch bot connected to Discord.");
            } catch (Exception e) {
                plugin.getLogger().severe("ScappiWatch bot failed to connect: " + e.getMessage());
            }
        });
    }

    @Override
    public void onSlashCommandInteraction(SlashCommandInteractionEvent event) {
        switch (event.getName()) {
            case "online" -> {
                event.deferReply().queue();
                onMainThread(() -> {
                    String players = Bukkit.getOnlinePlayers().stream()
                            .map(Player::getName).sorted()
                            .collect(Collectors.joining(", "));
                    event.getHook().sendMessage("**Online (" + Bukkit.getOnlinePlayers().size()
                            + "/" + Bukkit.getMaxPlayers() + "):** "
                            + (players.isEmpty() ? "nobody" : players)).queue();
                });
            }
            case "tps" -> {
                event.deferReply().queue();
                onMainThread(() -> {
                    double[] tps = Bukkit.getTPS();
                    event.getHook().sendMessage(String.format(
                            "**TPS:** %.2f (1m), %.2f (5m), %.2f (15m)",
                            Math.min(20, tps[0]), Math.min(20, tps[1]), Math.min(20, tps[2]))).queue();
                });
            }
            case "whereis" -> {
                String name = event.getOption("player").getAsString();
                event.deferReply().queue();
                onMainThread(() -> {
                    Player player = Bukkit.getPlayerExact(name);
                    if (player == null) {
                        event.getHook().sendMessage("`" + name + "` is not online.").queue();
                        return;
                    }
                    Location location = player.getLocation();
                    event.getHook().sendMessage("**" + player.getName() + "** is in `"
                            + location.getWorld().getName() + "` at `"
                            + location.getBlockX() + ", " + location.getBlockY() + ", "
                            + location.getBlockZ() + "`").queue();
                });
            }
            default -> {
            }
        }
    }

    private void onMainThread(Runnable task) {
        Bukkit.getScheduler().runTask(plugin, task);
    }

    public void shutdown() {
        JDA current = jda;
        if (current != null) {
            current.shutdownNow();
            jda = null;
        }
    }
}

package dev.scappi.scappiwatch;

import dev.scappi.core.config.ConfigMigrator;
import dev.scappi.core.metrics.MetricsBootstrap;
import dev.scappi.core.storage.HikariStorage;
import dev.scappi.core.storage.Storage;
import dev.scappi.core.storage.StorageSettings;
import dev.scappi.scappiwatch.alert.AlertRouter;
import dev.scappi.scappiwatch.anomaly.IpCountryTracker;
import dev.scappi.scappiwatch.anomaly.JoinBurstDetector;
import dev.scappi.scappiwatch.api.AlertEvent;
import dev.scappi.scappiwatch.api.ScappiWatchAPI;
import dev.scappi.scappiwatch.bot.WatchBot;
import dev.scappi.scappiwatch.listener.CommandListener;
import dev.scappi.scappiwatch.listener.DeathListener;
import dev.scappi.scappiwatch.listener.JoinQuitListener;
import dev.scappi.scappiwatch.monitor.TpsMonitor;
import dev.scappi.scappiwatch.monitor.WatchdogMonitor;
import org.bukkit.Bukkit;
import org.bukkit.event.HandlerList;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;

public final class ScappiWatch extends JavaPlugin {

    private static final int BSTATS_ID = 27100;

    private AlertRouter router;
    private Storage storage;
    private JoinBurstDetector joinBurstDetector;
    private IpCountryTracker ipCountryTracker;
    private TpsMonitor tpsMonitor;
    private WatchdogMonitor watchdogMonitor;
    private WatchBot bot;

    @Override
    public void onEnable() {
        loadEverything();
        MetricsBootstrap.start(this, BSTATS_ID);

        if (alertEnabled("server-start")) {
            emit(AlertEvent.builder("server-start", "Server started")
                    .color(AlertEvent.GREEN)
                    .field("Version", Bukkit.getVersion())
                    .build());
        }
    }

    @Override
    public void onDisable() {
        if (alertEnabled("server-stop")) {
            emit(AlertEvent.builder("server-stop", "Server stopping")
                    .color(AlertEvent.RED)
                    .field("Online at shutdown", String.valueOf(Bukkit.getOnlinePlayers().size()))
                    .build());
        }
        shutdownEverything();
    }

    /** Full config + service rebuild; used on enable and /scappiwatch reload. */
    public void reload() {
        shutdownEverything();
        loadEverything();
    }

    private void loadEverything() {
        ConfigMigrator.migrate(new File(getDataFolder(), "config.yml"),
                this::getResource, "config.yml", getLogger());
        reloadConfig();

        router = new AlertRouter(getConfig(), getLogger());
        ScappiWatchAPI.register(router::emit);

        if (getConfig().getBoolean("anomaly.ip-country.enabled", false)) {
            storage = new HikariStorage(StorageSettings.h2(getDataFolder().toPath(), "scappiwatch"));
        }
        joinBurstDetector = new JoinBurstDetector(this);
        ipCountryTracker = new IpCountryTracker(this, storage);

        Bukkit.getPluginManager().registerEvents(new JoinQuitListener(this), this);
        Bukkit.getPluginManager().registerEvents(new DeathListener(this), this);
        Bukkit.getPluginManager().registerEvents(new CommandListener(this), this);

        tpsMonitor = new TpsMonitor(this);
        tpsMonitor.start();
        watchdogMonitor = new WatchdogMonitor(this);
        watchdogMonitor.start();

        String token = getConfig().getString("bot.token", "");
        if (getConfig().getBoolean("bot.enabled", false) && !token.isBlank()
                && !token.equalsIgnoreCase("YOUR_TOKEN")) {
            bot = new WatchBot(this, token);
        }

        getCommand("scappiwatch").setExecutor(new WatchCommand(this));
        getCommand("scappiwatch").setTabCompleter(new WatchCommand(this));
    }

    private void shutdownEverything() {
        ScappiWatchAPI.unregister();
        HandlerList.unregisterAll(this);
        if (tpsMonitor != null) tpsMonitor.stop();
        if (watchdogMonitor != null) watchdogMonitor.stop();
        if (bot != null) {
            bot.shutdown();
            bot = null;
        }
        if (router != null) router.flushAndShutdown();
        if (storage != null) {
            storage.close();
            storage = null;
        }
    }

    /** Central emit point used by listeners, monitors and the public API. */
    public void emit(AlertEvent event) {
        if (router != null) router.emit(event);
    }

    public boolean alertEnabled(String key) {
        return getConfig().getBoolean("alerts." + key, true);
    }

    public JoinBurstDetector joinBurstDetector() {
        return joinBurstDetector;
    }

    public IpCountryTracker ipCountryTracker() {
        return ipCountryTracker;
    }
}

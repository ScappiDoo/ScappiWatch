package dev.scappi.scappiwatch.anomaly;

import dev.scappi.core.storage.Storage;
import dev.scappi.scappiwatch.ScappiWatch;
import dev.scappi.scappiwatch.api.AlertEvent;
import org.bukkit.entity.Player;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.ResultSet;
import java.time.Duration;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Alerts when an account logs in from a country it has never been seen in.
 * Country resolution uses a configurable HTTP geo endpoint (ip-api.com by
 * default), fully async; known countries per account persist in storage.
 */
public final class IpCountryTracker {

    private final ScappiWatch plugin;
    private final boolean enabled;
    private final String endpoint;
    private final Storage storage;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();

    public IpCountryTracker(ScappiWatch plugin, Storage storage) {
        this.plugin = plugin;
        this.enabled = plugin.getConfig().getBoolean("anomaly.ip-country.enabled", false) && storage != null;
        this.endpoint = plugin.getConfig().getString("anomaly.ip-country.endpoint",
                "http://ip-api.com/json/%ip%?fields=status,countryCode");
        this.storage = storage;
        if (enabled) {
            storage.execute("CREATE TABLE IF NOT EXISTS watch_player_countries ("
                    + "uuid VARCHAR(36) NOT NULL, country VARCHAR(8) NOT NULL, "
                    + "PRIMARY KEY (uuid, country))");
        }
    }

    public void checkAsync(Player player) {
        if (!enabled) return;
        InetSocketAddress address = player.getAddress();
        if (address == null || address.getAddress() == null) return;
        String ip = address.getAddress().getHostAddress();
        if (isLocal(ip)) return;

        UUID uuid = player.getUniqueId();
        String name = player.getName();

        lookupCountry(ip).thenAccept(country -> {
            if (country == null) return;
            storage.query("SELECT country FROM watch_player_countries WHERE uuid = ?",
                            resultSet -> readCountries(resultSet), uuid.toString())
                    .thenAccept(known -> {
                        if (known.contains(country)) return;
                        boolean returning = !known.isEmpty();
                        storage.update("INSERT INTO watch_player_countries (uuid, country) VALUES (?, ?)",
                                uuid.toString(), country);
                        if (returning) {
                            plugin.emit(AlertEvent.builder("anomaly", "Login from new country")
                                    .color(AlertEvent.RED)
                                    .field("Player", name)
                                    .field("New country", country)
                                    .field("Known countries", String.join(", ", known))
                                    .build());
                        }
                    });
        });
    }

    private java.util.concurrent.CompletableFuture<String> lookupCountry(String ip) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint.replace("%ip%", ip)))
                .timeout(Duration.ofSeconds(8)).GET().build();
        return http.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(response -> response.statusCode() == 200
                        ? parseCountryCode(response.body()) : null)
                .exceptionally(throwable -> null);
    }

    /** Pulls "countryCode":"XX" out of the JSON without a parser dependency. */
    public static String parseCountryCode(String json) {
        int key = json.indexOf("\"countryCode\"");
        if (key < 0) return null;
        int firstQuote = json.indexOf('"', key + "\"countryCode\"".length() + 1);
        if (firstQuote < 0) return null;
        int secondQuote = json.indexOf('"', firstQuote + 1);
        if (secondQuote < 0 || secondQuote - firstQuote > 8) return null;
        String code = json.substring(firstQuote + 1, secondQuote).trim();
        return code.isEmpty() ? null : code;
    }

    private static Set<String> readCountries(ResultSet resultSet) {
        Set<String> countries = new HashSet<>();
        try {
            while (resultSet.next()) countries.add(resultSet.getString(1));
        } catch (Exception ignored) {
        }
        return countries;
    }

    private static boolean isLocal(String ip) {
        return ip.startsWith("127.") || ip.startsWith("192.168.") || ip.startsWith("10.")
                || ip.equals("0:0:0:0:0:0:0:1") || ip.equals("::1");
    }
}

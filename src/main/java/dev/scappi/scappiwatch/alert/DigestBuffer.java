package dev.scappi.scappiwatch.alert;

import dev.scappi.core.discord.Embed;
import dev.scappi.core.discord.WebhookClient;
import dev.scappi.scappiwatch.api.AlertEvent;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.LongAdder;

/**
 * Accumulates low-value alerts (joins, quits, deaths...) and posts one summary
 * embed per interval instead of a live message per event.
 */
final class DigestBuffer {

    private static final int SAMPLE_LINES = 12;

    private final WebhookClient client;
    private final ScheduledExecutorService scheduler;
    private final Map<String, LongAdder> counts = new ConcurrentHashMap<>();
    private final List<String> samples = new ArrayList<>();
    private final boolean daily;
    private volatile Instant windowStart = Instant.now();

    DigestBuffer(WebhookClient client, boolean daily) {
        this.client = client;
        this.daily = daily;
        long interval = daily ? TimeUnit.DAYS.toMinutes(1) : 60;
        this.scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "scappi-digest");
            thread.setDaemon(true);
            return thread;
        });
        scheduler.scheduleAtFixedRate(this::flush, interval, interval, TimeUnit.MINUTES);
    }

    void add(AlertEvent event) {
        counts.computeIfAbsent(event.key(), key -> new LongAdder()).increment();
        synchronized (samples) {
            if (samples.size() < SAMPLE_LINES) {
                samples.add("• " + event.title());
            }
        }
    }

    void flush() {
        if (counts.isEmpty()) return;

        Embed embed = new Embed()
                .title((daily ? "Daily" : "Hourly") + " server digest")
                .color(AlertEvent.BLURPLE)
                .timestamp(Instant.now())
                .footer("Window started " + windowStart);
        counts.forEach((key, count) -> embed.field(key, String.valueOf(count.sum()), true));
        synchronized (samples) {
            if (!samples.isEmpty()) {
                embed.description(String.join("\n", samples));
                samples.clear();
            }
        }
        counts.clear();
        windowStart = Instant.now();
        client.send(embed);
    }

    void flushAndShutdown() {
        scheduler.shutdown();
        flush();
    }
}

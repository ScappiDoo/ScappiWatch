package dev.scappi.scappiwatch.api;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A single alert pushed to Discord. Other Scappi plugins build these and hand
 * them to {@link ScappiWatchAPI#emit(AlertEvent)}; ScappiWatch routes them to
 * the right webhook channel. Only JDK types on purpose — this class is the
 * cross-plugin contract.
 */
public final class AlertEvent {

    public static final int GREEN = 0x57F287;
    public static final int RED = 0xED4245;
    public static final int YELLOW = 0xFEE75C;
    public static final int ORANGE = 0xE67E22;
    public static final int BLURPLE = 0x5865F2;
    public static final int GRAY = 0x99AAB5;

    private final String key;
    private final String title;
    private final String description;
    private final int color;
    private final Map<String, String> fields;
    private final Instant timestamp;

    private AlertEvent(Builder builder) {
        this.key = builder.key;
        this.title = builder.title;
        this.description = builder.description;
        this.color = builder.color;
        this.fields = Collections.unmodifiableMap(builder.fields);
        this.timestamp = builder.timestamp;
    }

    /** @param key routing key, e.g. "deaths" or "punish.ban" */
    public static Builder builder(String key, String title) {
        return new Builder(key, title);
    }

    public String key() {
        return key;
    }

    public String title() {
        return title;
    }

    public String description() {
        return description;
    }

    public int color() {
        return color;
    }

    public Map<String, String> fields() {
        return fields;
    }

    public Instant timestamp() {
        return timestamp;
    }

    public static final class Builder {

        private final String key;
        private final String title;
        private String description;
        private int color = BLURPLE;
        private final Map<String, String> fields = new LinkedHashMap<>();
        private Instant timestamp = Instant.now();

        private Builder(String key, String title) {
            this.key = key;
            this.title = title;
        }

        public Builder description(String description) {
            this.description = description;
            return this;
        }

        public Builder color(int color) {
            this.color = color;
            return this;
        }

        public Builder field(String name, String value) {
            fields.put(name, value);
            return this;
        }

        public Builder timestamp(Instant timestamp) {
            this.timestamp = timestamp;
            return this;
        }

        public AlertEvent build() {
            return new AlertEvent(this);
        }
    }
}

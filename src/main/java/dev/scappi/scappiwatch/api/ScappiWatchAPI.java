package dev.scappi.scappiwatch.api;

import java.util.function.Consumer;

/**
 * Public entry point for other plugins. Always safe to call: while ScappiWatch
 * is absent or disabled, events vanish quietly.
 *
 * <pre>{@code
 * ScappiWatchAPI.emit(AlertEvent.builder("punish.ban", "Player banned")
 *         .color(AlertEvent.RED)
 *         .field("Player", name)
 *         .field("Reason", reason)
 *         .build());
 * }</pre>
 */
public final class ScappiWatchAPI {

    private static volatile Consumer<AlertEvent> sink;

    private ScappiWatchAPI() {
    }

    public static void emit(AlertEvent event) {
        Consumer<AlertEvent> current = sink;
        if (current != null && event != null) current.accept(event);
    }

    public static boolean isActive() {
        return sink != null;
    }

    /** Wired by ScappiWatch on enable/disable. Not for external use. */
    public static void register(Consumer<AlertEvent> consumer) {
        sink = consumer;
    }

    public static void unregister() {
        sink = null;
    }
}

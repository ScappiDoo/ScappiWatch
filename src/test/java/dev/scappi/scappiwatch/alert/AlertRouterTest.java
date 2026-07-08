package dev.scappi.scappiwatch.alert;

import dev.scappi.core.discord.Embed;
import dev.scappi.scappiwatch.api.AlertEvent;
import dev.scappi.scappiwatch.anomaly.IpCountryTracker;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AlertRouterTest {

    @Test
    void alertEventBecomesWellFormedEmbed() {
        AlertEvent event = AlertEvent.builder("deaths", "Scappi was slain by a zombie")
                .color(AlertEvent.ORANGE)
                .field("World", "world")
                .field("Location", "10, 64, -3")
                .build();

        Embed embed = AlertRouter.toEmbed(event);
        String json = embed.toJson();
        assertTrue(json.contains("\"title\":\"Scappi was slain by a zombie\""));
        assertTrue(json.contains("\"color\":" + AlertEvent.ORANGE));
        assertTrue(json.contains("\"name\":\"World\""));
        assertTrue(json.contains("\"value\":\"10, 64, -3\""));
    }

    @Test
    void geoJsonCountryCodeParsing() {
        assertEquals("DK", IpCountryTracker.parseCountryCode(
                "{\"status\":\"success\",\"countryCode\":\"DK\"}"));
        assertNull(IpCountryTracker.parseCountryCode("{\"status\":\"fail\"}"));
        assertNull(IpCountryTracker.parseCountryCode(""));
    }

    @Test
    void emptyFieldValueRendersPlaceholder() {
        Embed embed = AlertRouter.toEmbed(AlertEvent.builder("test", "t")
                .field("Empty", "").build());
        assertTrue(embed.toJson().contains("\"value\":\"-\""),
                "empty field values must not produce invalid embeds");
    }
}

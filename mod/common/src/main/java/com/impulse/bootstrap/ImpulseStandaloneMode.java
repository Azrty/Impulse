package com.impulse.bootstrap;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Installation-wide gate for users who elect to keep the unsupported Impulse build. */
public final class ImpulseStandaloneMode {
    private ImpulseStandaloneMode() { }

    public static boolean isLegacy(File gameDirectory) {
        if (Boolean.getBoolean("impulse.client")) return false;
        File root = gameDirectory == null ? new File(".") : gameDirectory;
        File settings = new File(new File(new File(root, "impulse"), "standalone"), "settings.json");
        try {
            if (!settings.isFile()) return false;
            JsonElement parsed = new JsonParser().parse(Files.readString(settings.toPath(), StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) return false;
            JsonObject object = parsed.getAsJsonObject();
            return object.has("migration_choice") && "stay".equalsIgnoreCase(object.get("migration_choice").getAsString());
        } catch (Exception ignored) {
            return false;
        }
    }

    public static boolean connectedServicesEnabled(File gameDirectory) {
        return !isLegacy(gameDirectory);
    }
}

package com.impulse.bootstrap;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;

/** Per-launch diagnostics shared by the early locator, helper process and runtime mod. */
public final class StandaloneLaunchLog {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final long MAX_AGE_MS = 30L * 24L * 60L * 60L * 1000L;
    private static final int MAX_LAUNCHES = 50;
    private static File gameDirectory;
    private static File launchDirectory;
    private static File logFile;
    private static long startedAt;
    private static String launchId;
    private static boolean shutdownRegistered;
    private static boolean reachedGame;

    private StandaloneLaunchLog() { }

    public static synchronized void start(File gameDir, String impulseVersion, String minecraftVersion, String loader, String loaderVersion) {
        if (logFile != null) return;
        try {
            gameDirectory = gameDir.getCanonicalFile();
            startedAt = System.currentTimeMillis();
            String stamp = new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(new Date(startedAt));
            launchId = stamp + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 6);
            File root = new File(new File(new File(gameDirectory, "impulse"), "standalone"), "logs");
            if (!root.exists() && !root.mkdirs()) throw new IOException("Could not create standalone log directory.");
            launchDirectory = new File(root, launchId);
            if (!launchDirectory.mkdirs()) throw new IOException("Could not create launch log directory.");
            logFile = new File(launchDirectory, "impulse.log");
            System.setProperty("impulse.standalone.launch.log", logFile.getAbsolutePath());
            System.setProperty("impulse.standalone.launch.directory", launchDirectory.getAbsolutePath());
            System.setProperty("impulse.standalone.launch.startedAt", Long.toString(startedAt));
            writeMetadata(impulseVersion, minecraftVersion, loader, loaderVersion, 0L);
            info("startup", "Standalone launch started", fields("launch_id", launchId, "minecraft", minecraftVersion,
                "loader", loader, "loader_version", loaderVersion, "impulse", impulseVersion));
            cleanup(root);
            if (!shutdownRegistered) {
                shutdownRegistered = true;
                Runtime.getRuntime().addShutdownHook(new Thread(StandaloneLaunchLog::finish, "Impulse Launch Log"));
            }
        } catch (Exception error) {
            System.err.println("[Impulse Log] Could not initialize per-launch logging: " + error.getMessage());
        }
    }

    public static synchronized void markGameReached() {
        reachedGame = true;
        info("launch", "NeoForge accepted Impulse mod candidates", null);
    }

    public static synchronized void attachFromSystemProperties(File gameDir) {
        if (logFile != null) return;
        String path = System.getProperty("impulse.standalone.launch.log", "");
        String directory = System.getProperty("impulse.standalone.launch.directory", "");
        if (path.isEmpty() || directory.isEmpty()) return;
        File candidate = new File(path);
        File candidateDirectory = new File(directory);
        if (!candidate.isFile() || !candidateDirectory.isDirectory()) return;
        gameDirectory = gameDir;
        launchDirectory = candidateDirectory;
        logFile = candidate;
        try { startedAt = Long.parseLong(System.getProperty("impulse.standalone.launch.startedAt", "0")); }
        catch (NumberFormatException ignored) { startedAt = 0L; }
    }

    public static synchronized void info(String phase, String message, Map<String, ?> fields) { write("INFO", phase, message, fields, null); }
    public static synchronized void warn(String phase, String message, Map<String, ?> fields) { write("WARN", phase, message, fields, null); }
    public static synchronized void error(String phase, String message, Throwable error) { write("ERROR", phase, message, null, error); }

    public static synchronized String currentLogPath() { return logFile == null ? null : logFile.getAbsolutePath(); }
    public static synchronized String currentLaunchDirectory() { return launchDirectory == null ? null : launchDirectory.getAbsolutePath(); }
    public static synchronized long currentStartedAt() { return startedAt; }

    public static Map<String, Object> fields(Object... values) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        for (int i = 0; i + 1 < values.length; i += 2) out.put(String.valueOf(values[i]), values[i + 1]);
        return out;
    }

    private static void write(String level, String phase, String message, Map<String, ?> fields, Throwable error) {
        if (logFile == null) return;
        StringBuilder line = new StringBuilder();
        line.append('[').append(iso(System.currentTimeMillis())).append("] [").append(level).append("] [")
            .append(sanitize(phase)).append("] ").append(sanitize(message));
        if (fields != null && !fields.isEmpty()) line.append(" | ").append(sanitize(GSON.toJson(fields)));
        if (error != null) line.append(" | ").append(sanitize(error.getClass().getSimpleName() + ": " + error.getMessage()));
        line.append('\n');
        try {
            FileOutputStream output = new FileOutputStream(logFile, true);
            try { output.write(line.toString().getBytes(StandardCharsets.UTF_8)); }
            finally { output.close(); }
        } catch (IOException ignored) { }
    }

    private static synchronized void finish() {
        if (logFile == null) return;
        long endedAt = System.currentTimeMillis();
        info("shutdown", "Standalone launch ended", fields("reached_game", reachedGame, "duration_ms", endedAt - startedAt));
        File minecraftLog = new File(new File(gameDirectory, "logs"), "latest.log");
        if (minecraftLog.isFile()) {
            try { Files.copy(minecraftLog.toPath(), new File(launchDirectory, "minecraft.log").toPath(), StandardCopyOption.REPLACE_EXISTING); }
            catch (IOException error) { warn("shutdown", "Could not snapshot Minecraft latest.log", fields("error", error.getMessage())); }
        }
        try { updateCompletedMetadata(endedAt); }
        catch (Exception error) { warn("shutdown", "Could not finalize launch metadata", fields("error", error.getMessage())); }
    }

    private static void writeMetadata(String impulse, String minecraft, String loader, String loaderVersion, long endedAt) throws IOException {
        Map<String, Object> metadata = new LinkedHashMap<String, Object>();
        metadata.put("schema_version", 1);
        metadata.put("launch_id", launchId);
        metadata.put("started_at", startedAt);
        metadata.put("ended_at", endedAt > 0 ? endedAt : null);
        metadata.put("reached_game", reachedGame);
        metadata.put("impulse_version", safe(impulse));
        metadata.put("minecraft_version", safe(minecraft));
        metadata.put("loader", safe(loader));
        metadata.put("loader_version", safe(loaderVersion));
        metadata.put("java_version", safe(System.getProperty("java.version")));
        metadata.put("os", safe(System.getProperty("os.name")));
        metadata.put("arch", safe(System.getProperty("os.arch")));
        atomicWrite(new File(launchDirectory, "metadata.json"), GSON.toJson(metadata));
    }

    @SuppressWarnings("unchecked")
    private static void updateCompletedMetadata(long endedAt) throws IOException {
        File file = new File(launchDirectory, "metadata.json");
        Map<String, Object> metadata = GSON.fromJson(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8), Map.class);
        metadata.put("ended_at", endedAt);
        metadata.put("reached_game", reachedGame);
        atomicWrite(file, GSON.toJson(metadata));
    }

    private static void cleanup(File root) {
        File[] entries = root.listFiles(File::isDirectory);
        if (entries == null) return;
        Arrays.sort(entries, Comparator.comparing(File::getName).reversed());
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        for (int i = 0; i < entries.length; i++) {
            File marker = new File(entries[i], "metadata.json");
            long modified = marker.isFile() ? marker.lastModified() : entries[i].lastModified();
            if (i >= MAX_LAUNCHES || modified < cutoff) delete(entries[i]);
        }
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        try { Files.deleteIfExists(file.toPath()); } catch (IOException ignored) { }
    }

    private static void atomicWrite(File target, String text) throws IOException {
        File part = new File(target.getParentFile(), target.getName() + ".part");
        Files.write(part.toPath(), text.getBytes(StandardCharsets.UTF_8));
        try { Files.move(part.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (Exception ignored) { Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    }

    private static String sanitize(String value) {
        String text = safe(value).replace('\r', ' ').replace('\n', ' ');
        String home = System.getProperty("user.home", "");
        if (!home.isEmpty()) text = text.replace(home, "<home>");
        text = text.replaceAll("(?i)(access[_-]?token|authorization|client[_-]?secret)([\\\"'=:\\s]+)[^,\\s\\\"]+", "$1$2<redacted>");
        text = text.replaceAll("(?i)(--username|setting user:|profile name:)([=:\\s]+)[^,\\s\\\"]+", "$1$2<redacted>");
        text = text.replaceAll("(?i)(uuid of player\\s+)\\S+", "$1<redacted>");
        text = text.replaceAll("(?i)(--uuid|uuid)([=:\\s]+)[0-9a-f-]{32,36}", "$1$2<redacted>");
        text = text.replaceAll("(?i)([?&](?:token|access_token|code|key|secret|password)=)[^&\\s]+", "$1<redacted>");
        return text.replaceAll("(?i)\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b", "<uuid-redacted>");
    }

    private static String safe(String value) { return value == null ? "" : value; }
    private static String iso(long time) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(time));
    }
}

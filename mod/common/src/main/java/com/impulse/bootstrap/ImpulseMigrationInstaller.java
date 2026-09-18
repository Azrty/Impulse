package com.impulse.bootstrap;

import com.google.gson.Gson;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.jar.JarFile;

/** Downloads and schedules the one-way handoff from Impulse to Erozion Go. */
public final class ImpulseMigrationInstaller {
    public static final String INDEX_URL = "https://updates.erozion.com/go/mc/index.json";
    private static final long MAX_JAR_BYTES = 256L * 1024L * 1024L;
    private static final int MAX_INDEX_BYTES = 1024 * 1024;
    private static final Gson GSON = new Gson();

    private ImpulseMigrationInstaller() { }

    public interface Progress {
        void update(String message, int completed, int total);
    }

    public static Prepared prepare(File gameDirectory, String minecraftVersion, String loader, Progress progress) throws Exception {
        File root = gameDirectory.getCanonicalFile();
        File currentJar = ImpulseModUpdater.locateInstalledJar(root);
        if (currentJar == null) throw new IOException("The installed Impulse jar could not be identified.");
        progress.update("Checking Erozion Go releases", 0, 1);
        Index index = GSON.fromJson(new String(readUrl(INDEX_URL, "application/json", MAX_INDEX_BYTES), StandardCharsets.UTF_8), Index.class);
        Release release = latest(index, minecraftVersion, loader);
        if (release == null) throw new IOException("No compatible Erozion Go release is available yet.");
        validateRelease(release);

        File staging = new File(root, ".eroziongo-migration");
        if (!staging.isDirectory() && !staging.mkdirs()) throw new IOException("Could not create the migration staging directory.");
        File pending = new File(staging, "erozion-go-" + safe(release.version) + ".pending");
        download(release, pending, progress);
        validateErozionGoJar(pending);

        Prepared prepared = new Prepared();
        prepared.version = release.version;
        prepared.pending = pending.getCanonicalPath();
        prepared.current_jar = currentJar.getCanonicalPath();
        prepared.size = release.size;
        progress.update("Erozion Go is ready", 1, 1);
        return prepared;
    }

    public static void schedule(File gameDirectory, Prepared prepared, long parentPid) throws Exception {
        if (prepared == null) throw new IOException("Erozion Go has not been prepared.");
        File root = gameDirectory.getCanonicalFile();
        File pending = new File(prepared.pending).getCanonicalFile();
        File current = new File(prepared.current_jar).getCanonicalFile();
        if (!pending.isFile()) throw new IOException("The prepared Erozion Go download is missing.");
        validateErozionGoJar(pending);
        if (!ImpulseModUpdater.isImpulseJar(current)) throw new IOException("The installed Impulse jar changed during migration.");
        File sourceData = new File(root, "impulse").getCanonicalFile();
        File targetData = new File(root, "eroziongo").getCanonicalFile();
        if (!sourceData.isDirectory()) throw new IOException("The Impulse data directory is missing.");
        if (targetData.exists()) throw new IOException("An eroziongo data directory already exists. It was not overwritten.");
        File targetJar = new File(new File(root, "mods"), "erozion-go.jar").getCanonicalFile();
        if (targetJar.exists()) throw new IOException("mods/erozion-go.jar already exists. It was not overwritten.");
        writeJournal(pending.getParentFile(), "prepared", prepared.version);
        if (isWindows()) scheduleWindows(root, parentPid, pending, current, sourceData, targetData, targetJar);
        else scheduleUnix(root, parentPid, pending, current, sourceData, targetData, targetJar);
    }

    static Release latest(Index index, String minecraftVersion, String loader) {
        if (index == null || index.releases == null) return null;
        Release best = null;
        for (Release release : index.releases) {
            if (release == null || !clean(minecraftVersion).equals(clean(release.minecraft_version))) continue;
            if (!clean(loader).equalsIgnoreCase(clean(release.loader))) continue;
            String channel = clean(release.channel);
            if (channel.isEmpty()) channel = clean(release.version).contains("-") ? "beta" : "stable";
            if (!"stable".equalsIgnoreCase(channel)) continue;
            try { validateRelease(release); } catch (Exception ignored) { continue; }
            if (best == null || ImpulseModUpdater.compareVersions(release.version, best.version) > 0) best = release;
        }
        return best;
    }

    private static void validateRelease(Release release) throws IOException {
        if (clean(release.version).isEmpty() || release.size <= 0L || release.size > MAX_JAR_BYTES) throw new IOException("Invalid Erozion Go release metadata.");
        if (!clean(release.sha512).matches("(?i)[0-9a-f]{128}")) throw new IOException("Erozion Go release is missing a valid SHA-512 hash.");
        approvedUrl(release.download_url);
    }

    private static void download(Release release, File target, Progress progress) throws Exception {
        File part = new File(target.getParentFile(), target.getName() + ".part");
        HttpURLConnection connection = open(release.download_url, "application/java-archive, application/octet-stream");
        MessageDigest digest = MessageDigest.getInstance("SHA-512");
        long written = 0L;
        long started = System.nanoTime();
        int lastPercent = -1;
        try (InputStream input = new BufferedInputStream(connection.getInputStream());
             OutputStream output = new BufferedOutputStream(new FileOutputStream(part))) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read == 0) continue;
                written += read;
                if (written > release.size || written > MAX_JAR_BYTES) throw new IOException("Erozion Go download exceeds its published size.");
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
                int percent = (int) Math.min(100L, written * 100L / release.size);
                if (percent != lastPercent) {
                    double seconds = Math.max(0.001d, (System.nanoTime() - started) / 1_000_000_000d);
                    progress.update("Downloading Erozion Go - " + percent + "% - " + speed(written / seconds), percent, 100);
                    lastPercent = percent;
                }
            }
        } catch (Exception error) {
            Files.deleteIfExists(part.toPath());
            throw error;
        } finally {
            connection.disconnect();
        }
        if (written != release.size) {
            Files.deleteIfExists(part.toPath());
            throw new IOException("Erozion Go download size mismatch.");
        }
        if (!hex(digest.digest()).equalsIgnoreCase(release.sha512)) {
            Files.deleteIfExists(part.toPath());
            throw new IOException("Erozion Go SHA-512 verification failed.");
        }
        Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    private static void validateErozionGoJar(File file) throws IOException {
        try (JarFile jar = new JarFile(file)) {
            boolean marker = jar.getJarEntry("erozion-go.embedded") != null || jar.getJarEntry("META-INF/erozion-go.json") != null;
            java.util.jar.JarEntry metadata = jar.getJarEntry("META-INF/neoforge.mods.toml");
            if (!marker || metadata == null) throw new IOException("The downloaded file is not an Erozion Go build.");
            String text;
            try (InputStream input = jar.getInputStream(metadata)) { text = new String(readLimited(input, 1024 * 1024), StandardCharsets.UTF_8); }
            if (!text.matches("(?s).*modId\\s*=\\s*[\"'](?:erozion_go|eroziongo)[\"'].*")) {
                throw new IOException("The downloaded file does not declare the Erozion Go mod ID.");
            }
        }
    }

    private static byte[] readUrl(String source, String accept, int maximum) throws IOException {
        HttpURLConnection connection = open(source, accept);
        try (InputStream input = connection.getInputStream()) { return readLimited(input, maximum); }
        finally { connection.disconnect(); }
    }

    private static HttpURLConnection open(String source, String accept) throws IOException {
        URL current = approvedUrl(source);
        for (int redirects = 0; redirects <= 5; redirects++) {
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("Accept", accept);
            connection.setRequestProperty("User-Agent", "Impulse-Migration/1");
            int status = connection.getResponseCode();
            if (status == 200) return connection;
            if (status < 300 || status > 399 || redirects == 5) {
                connection.disconnect();
                throw new IOException("Erozion Go service returned HTTP " + status + ".");
            }
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (location == null) throw new IOException("Erozion Go download redirect is missing its destination.");
            current = approvedUrl(new URL(current, location).toString());
        }
        throw new IOException("Too many Erozion Go redirects.");
    }

    private static URL approvedUrl(String value) throws IOException {
        try {
            URL url = new URL(clean(value));
            if (!"https".equalsIgnoreCase(url.getProtocol()) || !"updates.erozion.com".equalsIgnoreCase(url.getHost())
                || !url.getPath().startsWith("/go/mc/")) throw new IOException("Erozion Go downloads must come from updates.erozion.com/go/mc/.");
            return url;
        } catch (IllegalArgumentException error) { throw new IOException("Invalid Erozion Go URL.", error); }
    }

    private static void scheduleUnix(File root, long pid, File pending, File current, File sourceData, File targetData, File targetJar) throws IOException {
        File script = new File(pending.getParentFile(), "finish-migration.sh");
        String body = "#!/bin/sh\nPARENT=\"$1\"\nPENDING=\"$2\"\nCURRENT=\"$3\"\nSOURCE=\"$4\"\nDEST=\"$5\"\nTARGET=\"$6\"\nJOURNAL=\"$(dirname \"$PENDING\")/migration.json\"\n"
            + "journal() { printf '{\"status\":\"%s\"}\\n' \"$1\" > \"$JOURNAL.tmp\" && mv -f \"$JOURNAL.tmp\" \"$JOURNAL\"; }\n"
            + "fail() { journal failed; exit 1; }\njournal awaiting_exit\nwhile kill -0 \"$PARENT\" 2>/dev/null; do sleep 1; done\n"
            + "mv \"$SOURCE\" \"$DEST\" || fail\njournal data_moved\nmkdir -p \"$DEST/migration\" || { mv \"$DEST\" \"$SOURCE\"; fail; }\n"
            + "mv \"$CURRENT\" \"$DEST/migration/impulse-recovery.jar\" || { mv \"$DEST\" \"$SOURCE\"; fail; }\njournal impulse_backed_up\n"
            + "mv \"$PENDING\" \"$TARGET\" || { mv \"$DEST/migration/impulse-recovery.jar\" \"$CURRENT\"; mv \"$DEST\" \"$SOURCE\"; fail; }\n"
            + "printf '{\"status\":\"complete\"}\\n' > \"$DEST/migration/result.json\"\nrm -f -- \"$0\"\n";
        Files.writeString(script.toPath(), body, StandardCharsets.UTF_8);
        new ProcessBuilder("/bin/sh", script.getAbsolutePath(), Long.toString(pid), pending.getAbsolutePath(), current.getAbsolutePath(),
            sourceData.getAbsolutePath(), targetData.getAbsolutePath(), targetJar.getAbsolutePath()).directory(root).start();
    }

    private static void scheduleWindows(File root, long pid, File pending, File current, File sourceData, File targetData, File targetJar) throws IOException {
        File script = new File(pending.getParentFile(), "finish-migration.cmd");
        String body = "@echo off\r\nsetlocal\r\nset \"PARENT=%~1\"\r\nset \"PENDING=%~2\"\r\nset \"CURRENT=%~3\"\r\nset \"SOURCE=%~4\"\r\nset \"DEST=%~5\"\r\nset \"TARGET=%~6\"\r\nset \"JOURNAL=%~dp2migration.json\"\r\n"
            + ">\"%JOURNAL%\" echo {\"status\":\"awaiting_exit\"}\r\n"
            + ":wait\r\ntasklist /FI \"PID eq %PARENT%\" 2>NUL | find \"%PARENT%\" >NUL && (timeout /t 1 /nobreak >NUL & goto wait)\r\n"
            + "move /Y \"%SOURCE%\" \"%DEST%\" >NUL || goto failed\r\n>\"%JOURNAL%\" echo {\"status\":\"data_moved\"}\r\nmkdir \"%DEST%\\migration\" 2>NUL\r\n"
            + "move /Y \"%CURRENT%\" \"%DEST%\\migration\\impulse-recovery.jar\" >NUL || goto rollback_data\r\n"
            + ">\"%JOURNAL%\" echo {\"status\":\"impulse_backed_up\"}\r\n"
            + "move /Y \"%PENDING%\" \"%TARGET%\" >NUL || goto rollback_jar\r\n"
            + ">\"%DEST%\\migration\\result.json\" echo {\"status\":\"complete\"}\r\ngoto done\r\n"
            + ":rollback_jar\r\nmove /Y \"%DEST%\\migration\\impulse-recovery.jar\" \"%CURRENT%\" >NUL\r\n"
            + ":rollback_data\r\nmove /Y \"%DEST%\" \"%SOURCE%\" >NUL\r\n:failed\r\n>\"%JOURNAL%\" echo {\"status\":\"failed\"}\r\nexit /b 1\r\n:done\r\ndel \"%~f0\"\r\n";
        Files.writeString(script.toPath(), body, StandardCharsets.UTF_8);
        String command = "call \"" + script.getAbsolutePath() + "\" \"" + pid + "\" \"" + pending.getAbsolutePath() + "\" \""
            + current.getAbsolutePath() + "\" \"" + sourceData.getAbsolutePath() + "\" \"" + targetData.getAbsolutePath() + "\" \"" + targetJar.getAbsolutePath() + "\"";
        new ProcessBuilder("cmd.exe", "/d", "/s", "/c", command).directory(root).start();
    }

    private static byte[] readLimited(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (output.size() + read > maximum) throw new IOException("Response is too large.");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String speed(double bytesPerSecond) {
        if (bytesPerSecond >= 1024d * 1024d) return String.format(Locale.ROOT, "%.1f MiB/s", bytesPerSecond / 1024d / 1024d);
        return String.format(Locale.ROOT, "%.0f KiB/s", bytesPerSecond / 1024d);
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static String clean(String value) { return value == null ? "" : value.trim(); }

    private static void writeJournal(File directory, String status, String version) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not create the migration staging directory.");
        File target = new File(directory, "migration.json");
        File temporary = new File(directory, "migration.json.tmp");
        String json = "{\"status\":\"" + status + "\",\"version\":\"" + safe(version) + "\"}\n";
        Files.write(temporary.toPath(), json.getBytes(StandardCharsets.UTF_8));
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }
    private static String safe(String value) { return clean(value).replaceAll("[^A-Za-z0-9._-]", "_"); }
    private static boolean isWindows() { return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win"); }

    public static final class Prepared { public String version, pending, current_jar; public long size; }
    public static final class Index { public List<Release> releases = new ArrayList<Release>(); }
    public static final class Release {
        public String version, channel, minecraft_version, loader, file_name, download_url, sha512;
        public long size;
    }
}

package com.impulse.common;

import com.google.gson.Gson;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/** Checksum-verified updater for standalone clients and dedicated servers. */
public final class ImpulseModUpdater {
    public static final String DEFAULT_INDEX_URL = "https://impulse.epivalent.com/mods/index.json";
    public static final String DEFAULT_BETA_INDEX_URL = "https://impulse.epivalent.com/mods/beta-index.json";
    private static final int MAX_INDEX_BYTES = 1024 * 1024;
    private static final long MAX_JAR_BYTES = 256L * 1024L * 1024L;
    private static final Gson GSON = new Gson();
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);

    private ImpulseModUpdater() {
    }

    public static void checkAsync(final File gameDirectory, final String currentVersion, final String minecraftVersion, final String loader) {
        if (Boolean.parseBoolean(System.getProperty("impulse.client", "false"))) return;
        if (!STARTED.compareAndSet(false, true)) return;
        final File root = gameDirectory == null ? new File(".") : gameDirectory;
        final Properties settings = readSettings(root);
        String enabled = System.getProperty("impulse.updater.enabled", settings.getProperty("updater.enabled", "true"));
        if (!Boolean.parseBoolean(enabled)) return;

        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    check(root, clean(currentVersion), clean(minecraftVersion), cleanLoader(loader), settings);
                } catch (Throwable error) {
                    System.err.println("[Impulse Updater] Update check failed: " + message(error));
                }
            }
        }, "impulse-mod-updater");
        worker.setDaemon(true);
        worker.start();
    }

    static void check(File root, String currentVersion, String minecraftVersion, String loader, Properties settings) throws Exception {
        File currentJar = locateInstalledJar(root);
        if (currentJar != null) cleanupStaleBackups(root, currentJar);
        String channel = normalizeChannel(System.getProperty("impulse.updater.channel", settings.getProperty("updater.channel", "stable")));
        String indexUrl = updateIndexUrl(settings, channel);
        System.out.println("[Impulse Updater] Checking the " + channel + " channel for " + loader + " " + minecraftVersion
            + " (installed " + currentVersion + ") from " + indexUrl + ".");
        UpdateIndex index = readIndex(indexUrl);
        Release release = latestMatching(index, minecraftVersion, loader, currentVersion, channel);
        if (release == null) {
            System.out.println("[Impulse Updater] Impulse " + currentVersion + " is current for " + loader + " " + minecraftVersion + " on the " + channel + " channel.");
            return;
        }

        if (currentJar == null) {
            System.err.println("[Impulse Updater] Update " + release.version + " is available, but the installed Impulse jar could not be located.");
            return;
        }

        File updaterDirectory = new File(new File(root, "impulse"), "updater");
        if (!updaterDirectory.exists() && !updaterDirectory.mkdirs()) throw new IOException("Could not create " + updaterDirectory);
        File pending = new File(updaterDirectory, "impulse-" + safeVersion(release.version) + ".pending");
        downloadAndVerify(release, pending);
        scheduleReplacement(root, currentJar, pending);
        System.out.println("[Impulse Updater] Impulse " + release.version + " is ready and will be active after restart.");
    }

    private static UpdateIndex readIndex(String source) throws Exception {
        URL url = secureUrl(source);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(8000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "Impulse-Mod-Updater/1");
        try {
            int status = connection.getResponseCode();
            if (status != 200) throw new IOException("Update index returned HTTP " + status);
            byte[] body = readLimited(connection.getInputStream(), MAX_INDEX_BYTES);
            UpdateIndex index = GSON.fromJson(new String(body, StandardCharsets.UTF_8), UpdateIndex.class);
            if (index == null || index.releases == null) throw new IOException("Invalid update index");
            return index;
        } finally {
            connection.disconnect();
        }
    }

    static Release latestMatching(UpdateIndex index, String minecraftVersion, String loader, String currentVersion, String channel) {
        Release best = null;
        String selectedChannel = normalizeChannel(channel);
        for (Release candidate : index.releases) {
            if (candidate == null || !minecraftVersion.equals(clean(candidate.minecraft_version))) continue;
            if (!loader.equals(cleanLoader(candidate.loader))) continue;
            if ("stable".equals(selectedChannel) && !"stable".equals(releaseChannel(candidate))) continue;
            if (!validRelease(candidate) || compareVersions(candidate.version, currentVersion) <= 0) continue;
            if (best == null || compareVersions(candidate.version, best.version) > 0) best = candidate;
        }
        return best;
    }

    private static boolean validRelease(Release release) {
        if (clean(release.version).length() == 0 || clean(release.sha256).length() != 64) return false;
        if (!clean(release.sha256).matches("(?i)[0-9a-f]{64}")) return false;
        if (release.size <= 0 || release.size > MAX_JAR_BYTES) return false;
        try {
            secureUrl(release.download_url);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void downloadAndVerify(Release release, File target) throws Exception {
        File temporary = new File(target.getParentFile(), target.getName() + ".part");
        URL url = secureUrl(release.download_url);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("Accept", "application/java-archive, application/octet-stream");
        connection.setRequestProperty("User-Agent", "Impulse-Mod-Updater/1");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long written = 0;
        try {
            int status = connection.getResponseCode();
            if (status != 200) throw new IOException("Mod download returned HTTP " + status);
            InputStream input = new BufferedInputStream(connection.getInputStream());
            OutputStream output = new BufferedOutputStream(new FileOutputStream(temporary));
            try {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (read == 0) continue;
                    written += read;
                    if (written > MAX_JAR_BYTES || written > release.size) throw new IOException("Downloaded mod exceeds its published size");
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                }
            } finally {
                try { input.close(); } finally { output.close(); }
            }
        } finally {
            connection.disconnect();
        }
        if (written != release.size) throw new IOException("Downloaded mod size mismatch");
        String actual = hex(digest.digest());
        if (!actual.equalsIgnoreCase(release.sha256)) throw new IOException("Downloaded mod SHA-256 mismatch");
        move(temporary, target, true);
    }

    private static void scheduleReplacement(File root, File currentJar, File pending) throws Exception {
        File modsDirectory = new File(root, "mods").getCanonicalFile();
        File target = new File(modsDirectory, "impulse.jar").getCanonicalFile();
        if (target.exists() && !target.equals(currentJar.getCanonicalFile()) && !isImpulseJar(target)) {
            throw new IOException("Refusing to replace an unrelated mods/impulse.jar file");
        }
        if (isWindows()) {
            scheduleWindowsReplacement(root, currentJar.getCanonicalFile(), pending.getCanonicalFile(), target);
            return;
        }
        scheduleUnixReplacement(root, currentJar.getCanonicalFile(), pending.getCanonicalFile(), target);
    }

    private static void scheduleUnixReplacement(File root, File currentJar, File pending, File target) throws Exception {
        File updaterDirectory = new File(new File(root, "impulse"), "updater");
        File script = new File(updaterDirectory, "apply-update.sh");
        String body = "#!/bin/sh\n"
            + "PARENT=\"$1\"\n"
            + "SOURCE=\"$2\"\n"
            + "CURRENT=\"$3\"\n"
            + "TARGET=\"$4\"\n"
            + "BACKUP=\"${CURRENT}.old\"\n"
            + "while kill -0 \"$PARENT\" 2>/dev/null; do sleep 1; done\n"
            + "if [ -f \"$CURRENT\" ]; then mv -f \"$CURRENT\" \"$BACKUP\" || exit 1; fi\n"
            + "mv -f \"$SOURCE\" \"$TARGET\" || { [ -f \"$BACKUP\" ] && mv -f \"$BACKUP\" \"$CURRENT\"; exit 1; }\n"
            + "rm -f \"$BACKUP\"\n"
            + "rm -f -- \"$0\"\n";
        FileOutputStream output = new FileOutputStream(script);
        try { output.write(body.getBytes(StandardCharsets.UTF_8)); } finally { output.close(); }
        new ProcessBuilder("/bin/sh", script.getAbsolutePath(), currentProcessId(), pending.getAbsolutePath(), currentJar.getAbsolutePath(), target.getAbsolutePath())
            .directory(root).redirectErrorStream(true).start();
    }

    private static void scheduleWindowsReplacement(File root, File currentJar, File pending, File target) throws Exception {
        File updaterDirectory = new File(new File(root, "impulse"), "updater");
        File script = new File(updaterDirectory, "apply-update.cmd");
        String body = "@echo off\r\n"
            + "setlocal\r\n"
            + "set \"SOURCE=%~1\"\r\n"
            + "set \"CURRENT=%~2\"\r\n"
            + "set \"TARGET=%~3\"\r\n"
            + "set \"BACKUP=%CURRENT%.old\"\r\n"
            + "for /L %%I in (1,1,600) do (\r\n"
            + "  if exist \"%CURRENT%\" move /Y \"%CURRENT%\" \"%BACKUP%\" >nul 2>&1\r\n"
            + "  if not exist \"%CURRENT%\" (\r\n"
            + "    move /Y \"%SOURCE%\" \"%TARGET%\" >nul 2>&1\r\n"
            + "    if not exist \"%SOURCE%\" goto done\r\n"
            + "  )\r\n"
            + "  timeout /t 1 /nobreak >nul\r\n"
            + ")\r\n"
            + "goto failed\r\n"
            + ":done\r\n"
            + "if exist \"%BACKUP%\" del /F /Q \"%BACKUP%\" >nul 2>&1\r\n"
            + ":failed\r\n"
            + "del \"%~f0\"\r\n";
        FileOutputStream output = new FileOutputStream(script);
        try { output.write(body.getBytes(StandardCharsets.UTF_8)); } finally { output.close(); }
        String command = "call \"" + script.getAbsolutePath() + "\" \"" + pending.getAbsolutePath() + "\" \""
            + currentJar.getAbsolutePath() + "\" \"" + target.getAbsolutePath() + "\"";
        new ProcessBuilder("cmd.exe", "/d", "/s", "/c", command)
            .directory(root).redirectErrorStream(true).start();
    }

    private static String currentProcessId() {
        String runtimeName = ManagementFactory.getRuntimeMXBean().getName();
        int separator = runtimeName.indexOf('@');
        String value = separator > 0 ? runtimeName.substring(0, separator) : runtimeName;
        return value.matches("[0-9]+") ? value : "0";
    }

    static File locateInstalledJar(File root) throws Exception {
        File mods = new File(root, "mods").getCanonicalFile();
        if (!mods.isDirectory()) return null;
        File canonical = new File(mods, "impulse.jar");
        if (isImpulseJar(canonical)) return canonical;

        List<File> candidates = new ArrayList<File>();
        File[] files = mods.listFiles();
        if (files != null) {
            for (File file : files) {
                if (file.isFile() && file.getName().toLowerCase(Locale.ROOT).endsWith(".jar") && isImpulseJar(file)) candidates.add(file);
            }
        }
        if (candidates.size() == 1) return candidates.get(0);
        if (candidates.size() > 1) System.err.println("[Impulse Updater] Multiple Impulse jars were found in mods; update skipped to avoid replacing the wrong file.");
        return null;
    }

    static int cleanupStaleBackups(File root, File currentJar) throws Exception {
        if (currentJar == null || !isImpulseJar(currentJar)) return 0;
        File mods = new File(root, "mods").getCanonicalFile();
        File[] files = mods.listFiles();
        if (files == null) return 0;
        int removed = 0;
        for (File file : files) {
            if (!file.isFile() || !file.getName().toLowerCase(Locale.ROOT).endsWith(".jar.old")) continue;
            if (!isImpulseJar(file)) continue;
            try {
                if (Files.deleteIfExists(file.toPath())) removed++;
            } catch (IOException error) {
                System.err.println("[Impulse Updater] Could not remove stale backup " + file.getName() + ": " + error.getMessage());
            }
        }
        if (removed > 0) System.out.println("[Impulse Updater] Removed " + removed + " stale Impulse update backup(s).");
        return removed;
    }

    static boolean isImpulseJar(File file) {
        if (file == null || !file.isFile()) return false;
        JarFile jar = null;
        try {
            jar = new JarFile(file);
            if (jar.getJarEntry("impulse-runtime.embedded") != null) return true;
            if (jar.getJarEntry("com/impulse/common/ImpulseModUpdater.class") == null) return false;
            JarEntry neo = jar.getJarEntry("META-INF/neoforge.mods.toml");
            JarEntry forge = jar.getJarEntry("META-INF/mods.toml");
            JarEntry legacy = jar.getJarEntry("mcmod.info");
            return neo != null || forge != null || legacy != null;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (jar != null) try { jar.close(); } catch (Exception ignored) { }
        }
    }

    static Properties readSettings(File root) {
        Properties properties = new Properties();
        File file = new File(new File(root, "config"), "impulse-server.properties");
        if (file.isFile()) {
            FileInputStream input = null;
            try {
                input = new FileInputStream(file);
                properties.load(input);
            } catch (Exception ignored) {
            } finally {
                if (input != null) try { input.close(); } catch (Exception ignored) { }
            }
        }
        File standalone = new File(new File(new File(root, "impulse"), "standalone"), "settings.json");
        if (standalone.isFile()) {
            InputStreamReader reader = null;
            try {
                reader = new InputStreamReader(new FileInputStream(standalone), StandardCharsets.UTF_8);
                StandaloneSettings settings = GSON.fromJson(reader, StandaloneSettings.class);
                if (settings != null) properties.setProperty("updater.channel", normalizeChannel(settings.update_channel));
            } catch (Exception ignored) {
            } finally {
                if (reader != null) try { reader.close(); } catch (Exception ignored) { }
            }
        }
        return properties;
    }

    private static URL secureUrl(String value) throws Exception {
        URL url = new URL(clean(value));
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IOException("Update URLs must use HTTPS");
        return url;
    }

    private static byte[] readLimited(InputStream stream, int maximum) throws IOException {
        try {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) >= 0) {
                if (output.size() + read > maximum) throw new IOException("Update index is too large");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } finally {
            stream.close();
        }
    }

    private static void move(File source, File target, boolean replace) throws IOException {
        if (target.getParentFile() != null && !target.getParentFile().exists()) target.getParentFile().mkdirs();
        try {
            if (replace) Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            else Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            if (replace) Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            else Files.move(source.toPath(), target.toPath());
        }
    }

    static int compareVersions(String left, String right) {
        String leftValue = clean(left).replaceFirst("^[vV]", "").split("\\+", 2)[0];
        String rightValue = clean(right).replaceFirst("^[vV]", "").split("\\+", 2)[0];
        String[] leftVersion = leftValue.split("-", 2);
        String[] rightVersion = rightValue.split("-", 2);
        String[] leftParts = leftVersion[0].split("\\.");
        String[] rightParts = rightVersion[0].split("\\.");
        int length = Math.max(leftParts.length, rightParts.length);
        for (int i = 0; i < length; i++) {
            int a = i < leftParts.length ? number(leftParts[i]) : 0;
            int b = i < rightParts.length ? number(rightParts[i]) : 0;
            if (a != b) return a < b ? -1 : 1;
        }
        boolean leftPre = leftVersion.length > 1;
        boolean rightPre = rightVersion.length > 1;
        if (leftPre != rightPre) return leftPre ? -1 : 1;
        if (!leftPre) return 0;
        String[] leftPreParts = leftVersion[1].split("\\.");
        String[] rightPreParts = rightVersion[1].split("\\.");
        int preLength = Math.max(leftPreParts.length, rightPreParts.length);
        for (int i = 0; i < preLength; i++) {
            if (i >= leftPreParts.length) return -1;
            if (i >= rightPreParts.length) return 1;
            String a = leftPreParts[i];
            String b = rightPreParts[i];
            boolean aNumeric = a.matches("[0-9]+");
            boolean bNumeric = b.matches("[0-9]+");
            if (aNumeric && bNumeric) {
                int compared = Integer.compare(number(a), number(b));
                if (compared != 0) return compared;
            } else if (aNumeric != bNumeric) {
                return aNumeric ? -1 : 1;
            } else {
                int compared = a.compareToIgnoreCase(b);
                if (compared != 0) return compared;
            }
        }
        return 0;
    }

    private static String releaseChannel(Release release) {
        String explicit = clean(release.channel).toLowerCase(Locale.ROOT);
        if ("stable".equals(explicit) || "beta".equals(explicit)) return explicit;
        return clean(release.version).contains("-") ? "beta" : "stable";
    }

    private static String normalizeChannel(String value) {
        return "beta".equalsIgnoreCase(clean(value)) ? "beta" : "stable";
    }

    static String updateIndexUrl(Properties settings, String channel) {
        String genericOverride = clean(System.getProperty("impulse.updater.index", ""));
        if (genericOverride.length() > 0) return genericOverride;
        if ("beta".equals(normalizeChannel(channel))) {
            return clean(System.getProperty("impulse.updater.betaIndex",
                settings.getProperty("updater.betaIndexUrl", DEFAULT_BETA_INDEX_URL)));
        }
        return clean(settings.getProperty("updater.indexUrl", DEFAULT_INDEX_URL));
    }

    private static int number(String value) {
        try { return Integer.parseInt(value.replaceAll("[^0-9].*$", "")); } catch (Exception ignored) { return 0; }
    }

    private static String safeVersion(String value) {
        String clean = clean(value).replaceAll("[^0-9A-Za-z._-]", "-");
        return clean.length() == 0 ? "update" : clean;
    }

    private static String cleanLoader(String value) {
        return "neoforge".equalsIgnoreCase(clean(value)) ? "neoforge" : "forge";
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String message(Throwable error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.trim().length() == 0 ? error.getClass().getSimpleName() : message;
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return output.toString();
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    public static final class UpdateIndex {
        public int schema_version;
        public List<Release> releases = new ArrayList<Release>();
    }

    public static final class Release {
        public String version;
        public String channel;
        public String minecraft_version;
        public String loader;
        public String download_url;
        public String sha256;
        public long size;
    }

    private static final class StandaloneSettings {
        String update_channel;
    }
}

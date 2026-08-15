package com.impulse.neoforge121;

import net.minecraft.client.Minecraft;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Base64;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class ImpulseSpotifyDetector121 {
    public interface Listener {
        void activityChanged(ImpulseMusicActivity121 activity);
    }

    public record Status(boolean enabled, String state, String detail, String currentTrack, String artworkState, String lastError, long lastSuccessAt) {
    }

    private static final ScheduledExecutorService WORKER = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "Impulse Spotify Detector");
        thread.setDaemon(true);
        return thread;
    });
    private static final String MAC_SCRIPT = "tell application \"Spotify\"\n"
        + "if player state is playing then\n"
        + "return (name of current track as string) & (character id 31) & (artist of current track as string) & (character id 31) & (artwork url of current track as string)\n"
        + "end if\n"
        + "end tell\n"
        + "return \"\"";

    private static volatile boolean enabled;
    private static volatile Listener listener;
    private static volatile Process windowsBridge;
    private static volatile long nextWindowsStartAt;
    private static volatile ImpulseMusicActivity121 activity;
    private static volatile String state = "Disabled";
    private static volatile String detail = "Spotify activity sharing is off.";
    private static volatile String lastError = "";
    private static volatile String artworkState = "Animated fallback";
    private static volatile long lastSuccessAt;
    private static boolean scheduled;
    private static boolean shutdownHookRegistered;

    private ImpulseSpotifyDetector121() {
    }

    public static synchronized void setEnabled(boolean value, Listener nextListener) {
        listener = nextListener;
        if (enabled == value) return;
        enabled = value;
        if (!value) {
            stopWindowsBridge();
            updateActivity(null);
            state = "Disabled";
            detail = "Spotify activity sharing is off.";
            lastError = "";
            return;
        }
        state = "Starting";
        detail = "Looking for Spotify Desktop.";
        ensureScheduled();
    }

    public static Status status() {
        ImpulseMusicActivity121 current = activity;
        return new Status(enabled, state, detail,
            current == null ? "" : current.title() + " by " + current.artist(), artworkState, lastError, lastSuccessAt);
    }

    public static ImpulseMusicActivity121 currentActivity() {
        ImpulseMusicActivity121 current = activity;
        return current != null && current.isFresh() ? current : null;
    }

    public static synchronized void shutdown() {
        enabled = false;
        stopWindowsBridge();
        updateActivity(null);
    }

    private static synchronized void ensureScheduled() {
        if (scheduled) return;
        scheduled = true;
        if (!shutdownHookRegistered) {
            shutdownHookRegistered = true;
            Runtime.getRuntime().addShutdownHook(new Thread(ImpulseSpotifyDetector121::shutdown, "Impulse Spotify Shutdown"));
        }
        WORKER.scheduleWithFixedDelay(ImpulseSpotifyDetector121::poll, 0L, 2L, TimeUnit.SECONDS);
    }

    private static void poll() {
        if (!enabled) return;
        try {
            if (isWindows()) monitorWindows();
            else if (isMac()) pollMac();
            else {
                state = "Unsupported platform";
                detail = "Spotify activity is currently supported on Windows and macOS.";
                updateActivity(null);
            }
        } catch (Throwable error) {
            detectorError(readableError(error));
        }
    }

    private static void monitorWindows() throws Exception {
        Process process = windowsBridge;
        if (process != null && process.isAlive()) return;
        if (System.currentTimeMillis() < nextWindowsStartAt) return;
        stopWindowsBridge();
        File script = extractWindowsScript();
        File executable = new File(System.getenv().getOrDefault("SystemRoot", "C:\\Windows"), "System32/WindowsPowerShell/v1.0/powershell.exe");
        if (!executable.isFile()) throw new IllegalStateException("Windows PowerShell is unavailable.");
        Process next = new ProcessBuilder(executable.getAbsolutePath(), "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass", "-File", script.getAbsolutePath()).start();
        windowsBridge = next;
        state = "Connecting to Spotify";
        detail = "Reading the Spotify Desktop media session.";
        Thread output = new Thread(() -> readWindowsOutput(next), "Impulse Spotify Output");
        output.setDaemon(true);
        output.start();
        Thread errors = new Thread(() -> readWindowsErrors(next), "Impulse Spotify Errors");
        errors.setDaemon(true);
        errors.start();
        next.onExit().thenRun(() -> {
            if (enabled) {
                nextWindowsStartAt = System.currentTimeMillis() + 10_000L;
                if (windowsBridge == next) windowsBridge = null;
            }
        });
    }

    private static void readWindowsOutput(Process process) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) handleWindowsLine(line);
        } catch (Exception error) {
            if (enabled) detectorError(readableError(error));
        }
    }

    private static void handleWindowsLine(String line) {
        if (line.startsWith("MUSIC\t")) {
            String[] parts = line.split("\\t", 4);
            if (parts.length < 3) return;
            try {
                String title = new String(Base64.getDecoder().decode(parts[1]), StandardCharsets.UTF_8);
                String artist = new String(Base64.getDecoder().decode(parts[2]), StandardCharsets.UTF_8);
                byte[] sourceArtwork = parts.length == 4 && !parts[3].isBlank() ? Base64.getDecoder().decode(parts[3]) : null;
                playing(title, artist, sourceArtwork);
            } catch (Exception error) {
                detectorError("Spotify returned invalid media information.");
            }
        } else if (line.equals("STOPPED")) {
            notPlaying("Spotify Desktop is open, but no music is playing.");
        } else if (line.equals("NOT_FOUND")) {
            notPlaying("Open Spotify Desktop to share what you are listening to.");
        } else if (line.startsWith("ERROR\t")) {
            detectorError(line.substring(6).trim());
        }
    }

    private static void readWindowsErrors(Process process) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
            String line;
            String latest = "";
            while ((line = reader.readLine()) != null) if (!line.isBlank()) latest = line.trim();
            if (enabled && !latest.isBlank()) detectorError(latest);
        } catch (Exception ignored) {
        }
    }

    private static void pollMac() throws Exception {
        Process check = new ProcessBuilder("/usr/bin/pgrep", "-x", "Spotify").start();
        boolean finished = check.waitFor(1L, TimeUnit.SECONDS);
        if (!finished) {
            check.destroyForcibly();
            check.waitFor(1L, TimeUnit.SECONDS);
            notPlaying("Open Spotify Desktop to share what you are listening to.");
            return;
        }
        if (check.exitValue() != 0) {
            notPlaying("Open Spotify Desktop to share what you are listening to.");
            return;
        }
        Process process = new ProcessBuilder("/usr/bin/osascript", "-e", MAC_SCRIPT).start();
        boolean completed = process.waitFor(4L, TimeUnit.SECONDS);
        if (!completed) {
            process.destroyForcibly();
            throw new IllegalStateException("Spotify did not answer within four seconds.");
        }
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        String error = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        if (process.exitValue() != 0) {
            if (error.contains("-1743") || error.toLowerCase(Locale.ROOT).contains("not authorized")) {
                state = "Permission required";
                detail = "Allow Java or Minecraft to control Spotify in macOS Privacy & Security settings.";
                lastError = error;
                updateActivity(null);
                return;
            }
            throw new IllegalStateException(error.isBlank() ? "Spotify media detection failed." : error);
        }
        String[] fields = output.split(String.valueOf((char)31), 3);
        if (fields.length < 2 || fields[0].isBlank() || fields[1].isBlank()) {
            notPlaying("Spotify Desktop is open, but no music is playing.");
            return;
        }
        ImpulseMusicActivity121 current = activity;
        boolean sameTrack = current != null
            && current.title().equals(ImpulseMusicActivity121.sanitize(fields[0]))
            && current.artist().equals(ImpulseMusicActivity121.sanitize(fields[1]));
        byte[] sourceArtwork = !sameTrack && fields.length == 3 ? downloadArtwork(fields[2]) : null;
        playing(fields[0], fields[1], sourceArtwork);
    }

    private static void playing(String title, String artist, byte[] sourceArtwork) {
        try {
            String cleanTitle = ImpulseMusicActivity121.sanitize(title);
            String cleanArtist = ImpulseMusicActivity121.sanitize(artist);
            ImpulseMusicActivity121 current = activity;
            ImpulseMusicActivity121 next;
            if (current != null && current.title().equals(cleanTitle) && current.artist().equals(cleanArtist)) {
                next = current.refreshed();
            } else {
                byte[] artwork = prepareArtwork(sourceArtwork);
                next = ImpulseMusicActivity121.fresh(cleanTitle, cleanArtist, "", artwork);
            }
            state = "Playing on Spotify";
            detail = "Your current song is shared live above your player for other Impulse users.";
            artworkState = next.artworkId().isEmpty() ? "Animated fallback" : "Artwork available";
            lastError = "";
            lastSuccessAt = System.currentTimeMillis();
            updateActivity(next);
        } catch (IllegalArgumentException error) {
            detectorError(error.getMessage());
        }
    }

    private static void notPlaying(String message) {
        state = "Not playing";
        detail = message;
        artworkState = "Animated fallback";
        lastError = "";
        lastSuccessAt = System.currentTimeMillis();
        updateActivity(null);
    }

    private static void detectorError(String message) {
        state = "Spotify unavailable";
        detail = "Impulse could not read Spotify Desktop. Minecraft is unaffected.";
        artworkState = "Artwork error";
        lastError = message;
        updateActivity(null);
    }

    private static synchronized void updateActivity(ImpulseMusicActivity121 next) {
        ImpulseMusicActivity121 previous = activity;
        boolean changed = previous == null ? next != null : next == null || !previous.sameTrack(next);
        activity = next;
        if (changed && listener != null) listener.activityChanged(next);
    }

    private static byte[] downloadArtwork(String value) {
        HttpURLConnection connection = null;
        try {
            URI uri = URI.create(value == null ? "" : value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme())) return null;
            connection = (HttpURLConnection) uri.toURL().openConnection();
            connection.setConnectTimeout(3_000);
            connection.setReadTimeout(4_000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "Impulse-NeoForge/1.21.1");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return null;
            int declared = connection.getContentLength();
            if (declared > 2 * 1024 * 1024) return null;
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16 * 1024];
                int total = 0;
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    total += read;
                    if (total > 2 * 1024 * 1024) return null;
                    output.write(buffer, 0, read);
                }
                return output.toByteArray();
            }
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] prepareArtwork(byte[] source) {
        if (source == null || source.length == 0 || source.length > 2 * 1024 * 1024) return null;
        try {
            BufferedImage original = ImageIO.read(new ByteArrayInputStream(source));
            if (original == null || original.getWidth() <= 0 || original.getHeight() <= 0) return null;
            int side = Math.min(original.getWidth(), original.getHeight());
            int sourceX = (original.getWidth() - side) / 2;
            int sourceY = (original.getHeight() - side) / 2;
            BufferedImage square = new BufferedImage(64, 64, BufferedImage.TYPE_INT_RGB);
            Graphics2D graphics = square.createGraphics();
            try {
                graphics.setColor(Color.BLACK);
                graphics.fillRect(0, 0, 64, 64);
                graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
                graphics.drawImage(original, 0, 0, 64, 64, sourceX, sourceY, sourceX + side, sourceY + side, null);
            } finally {
                graphics.dispose();
            }
            Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
            if (!writers.hasNext()) return null;
            ImageWriter writer = writers.next();
            try {
                for (float quality : new float[] { 0.86F, 0.72F, 0.58F, 0.44F }) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    try (ImageOutputStream imageOutput = ImageIO.createImageOutputStream(output)) {
                        writer.setOutput(imageOutput);
                        ImageWriteParam parameters = writer.getDefaultWriteParam();
                        parameters.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                        parameters.setCompressionQuality(quality);
                        writer.write(null, new IIOImage(square, null, null), parameters);
                    }
                    byte[] encoded = output.toByteArray();
                    if (encoded.length <= ImpulseMusicActivity121.MAX_ARTWORK_BYTES) return encoded;
                    writer.reset();
                }
            } finally {
                writer.dispose();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static File extractWindowsScript() throws Exception {
        File directory = new File(Minecraft.getInstance().gameDirectory, "impulse/presence");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Could not create the Impulse presence directory.");
        File target = new File(directory, "windows-spotify.ps1");
        byte[] source;
        try (InputStream input = ImpulseSpotifyDetector121.class.getResourceAsStream("/impulse/presence/windows-spotify.ps1")) {
            if (input == null) throw new IllegalStateException("The Windows Spotify bridge is missing from Impulse.");
            source = input.readAllBytes();
        }
        if (target.isFile() && java.util.Arrays.equals(source, Files.readAllBytes(target.toPath()))) return target;
        File temporary = new File(directory, target.getName() + ".tmp");
        Files.write(temporary.toPath(), source);
        try {
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception ignored) {
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        return target;
    }

    private static synchronized void stopWindowsBridge() {
        Process process = windowsBridge;
        windowsBridge = null;
        if (process != null && process.isAlive()) {
            process.destroy();
            try {
                if (!process.waitFor(1L, TimeUnit.SECONDS)) process.destroyForcibly();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    private static boolean isMac() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac");
    }

    private static String readableError(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null && current.getCause() != current) current = current.getCause();
        String message = current.getMessage();
        return message == null || message.isBlank() ? current.getClass().getSimpleName() : message;
    }
}

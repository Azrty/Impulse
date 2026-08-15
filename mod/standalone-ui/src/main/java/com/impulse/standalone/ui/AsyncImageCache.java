package com.impulse.standalone.ui;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;

import javax.imageio.ImageIO;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/** Downloads and decodes Modrinth media away from the ImGui render thread. */
final class AsyncImageCache implements AutoCloseable {
    private static final int MAX_DOWNLOAD_BYTES = 6 * 1024 * 1024;
    private static final long MAX_CACHE_BYTES = 100L * 1024L * 1024L;
    private static final long MAX_CACHE_AGE_MS = 30L * 24L * 60L * 60L * 1000L;
    private static final int MAX_TEXTURES = 96;
    private static final int MAX_PENDING = 24;
    private static final long CLEAN_INTERVAL_MS = 60L * 1000L;
    private static final String USER_AGENT = "Azrty/Impulse-Standalone (https://impulsemc.com)";

    private final File cacheDirectory;
    private final ExecutorService workers = Executors.newFixedThreadPool(3, runnable -> {
        Thread thread = new Thread(runnable, "impulse-modrinth-image");
        thread.setDaemon(true);
        return thread;
    });
    private final Set<String> pending = java.util.Collections.synchronizedSet(new HashSet<String>());
    private final Set<String> failed = java.util.Collections.synchronizedSet(new HashSet<String>());
    private final ConcurrentLinkedQueue<DecodedImage> decoded = new ConcurrentLinkedQueue<DecodedImage>();
    private final LinkedHashMap<String, Texture> textures = new LinkedHashMap<String, Texture>(32, 0.75F, true);
    private final AtomicLong lastCleanup = new AtomicLong();
    private volatile boolean closed;

    AsyncImageCache(File gameDirectory) {
        this.cacheDirectory = new File(gameDirectory, "impulse/standalone/ui/cache/modrinth-images");
        if (!cacheDirectory.exists()) cacheDirectory.mkdirs();
        ImageIO.scanForPlugins();
        lastCleanup.set(System.currentTimeMillis());
        workers.execute(this::cleanDiskCache);
    }

    Texture request(String rawUrl, int maxDimension) {
        if (closed || !allowed(rawUrl)) return null;
        int dimension = Math.max(32, Math.min(1280, maxDimension));
        String key = hash(rawUrl + "#" + dimension);
        synchronized (textures) {
            Texture texture = textures.get(key);
            if (texture != null) return texture;
        }
        if (failed.contains(key) || pending.size() >= MAX_PENDING || !pending.add(key)) return null;
        workers.execute(() -> load(key, rawUrl, dimension));
        return null;
    }

    void pumpUploads() {
        for (int count = 0; count < 1; count++) {
            DecodedImage image = decoded.poll();
            if (image == null) break;
            pending.remove(image.key);
            if (closed) continue;
            int textureId = upload(image);
            if (textureId == 0) {
                failed.add(image.key);
                continue;
            }
            synchronized (textures) {
                textures.put(image.key, new Texture(textureId, image.width, image.height));
                while (textures.size() > MAX_TEXTURES) {
                    Map.Entry<String, Texture> eldest = textures.entrySet().iterator().next();
                    GL11.glDeleteTextures(eldest.getValue().id);
                    textures.remove(eldest.getKey());
                }
            }
        }
    }

    private void load(String key, String rawUrl, int maxDimension) {
        try {
            File cached = new File(cacheDirectory, key + ".png");
            BufferedImage image;
            if (cached.isFile() && System.currentTimeMillis() - cached.lastModified() <= MAX_CACHE_AGE_MS) {
                image = readImage(new FileInputStream(cached), maxDimension);
                cached.setLastModified(System.currentTimeMillis());
            } else {
                byte[] data = download(rawUrl);
                image = readImage(new ByteArrayInputStream(data), maxDimension);
                image = resize(image, maxDimension);
                writeCache(cached, image);
                scheduleCacheCleanup();
            }
            if (image == null) throw new IOException("Unsupported image format.");
            decoded.add(toPixels(key, image));
        } catch (Throwable error) {
            pending.remove(key);
            failed.add(key);
            System.out.println("[Impulse UI] Could not load Modrinth image: " + error.getMessage());
        }
    }

    private static byte[] download(String rawUrl) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) URI.create(rawUrl).toURL().openConnection();
        connection.setConnectTimeout(7000);
        connection.setReadTimeout(20000);
        connection.setRequestProperty("Accept", "image/*");
        connection.setRequestProperty("User-Agent", USER_AGENT);
        int status = connection.getResponseCode();
        if (!allowed(connection.getURL().toString())) {
            connection.disconnect();
            throw new IOException("Image redirected outside the Modrinth CDN.");
        }
        if (status != 200) {
            connection.disconnect();
            throw new IOException("Image CDN returned HTTP " + status + ".");
        }
        int announced = connection.getContentLength();
        if (announced > MAX_DOWNLOAD_BYTES) {
            connection.disconnect();
            throw new IOException("Image exceeds 6 MiB.");
        }
        try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (output.size() + read > MAX_DOWNLOAD_BYTES) throw new IOException("Image exceeds 6 MiB.");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } finally {
            connection.disconnect();
        }
    }

    private static BufferedImage readImage(InputStream input, int maxDimension) throws IOException {
        try (InputStream closeable = input; ImageInputStream imageInput = ImageIO.createImageInputStream(closeable)) {
            if (imageInput == null) throw new IOException("Unsupported image format.");
            Iterator<ImageReader> readers = ImageIO.getImageReaders(imageInput);
            if (!readers.hasNext()) throw new IOException("Unsupported image format.");
            ImageReader reader = readers.next();
            try {
                reader.setInput(imageInput, true, true);
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                int longest = Math.max(width, height);
                int sample = Math.max(1, (int) Math.ceil((double) longest / Math.max(1, maxDimension)));
                ImageReadParam parameters = reader.getDefaultReadParam();
                if (sample > 1) parameters.setSourceSubsampling(sample, sample, 0, 0);
                BufferedImage image = reader.read(0, parameters);
                if (image == null) throw new IOException("Unsupported image format.");
                return image;
            } finally {
                reader.dispose();
            }
        }
    }

    private static BufferedImage resize(BufferedImage source, int maxDimension) {
        int longest = Math.max(source.getWidth(), source.getHeight());
        if (longest <= maxDimension) return source;
        double scale = (double) maxDimension / longest;
        int width = Math.max(1, (int) Math.round(source.getWidth() * scale));
        int height = Math.max(1, (int) Math.round(source.getHeight() * scale));
        BufferedImage target = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = target.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            graphics.drawImage(source, 0, 0, width, height, null);
        } finally {
            graphics.dispose();
        }
        return target;
    }

    private static DecodedImage toPixels(String key, BufferedImage image) {
        ByteBuffer pixels = BufferUtils.createByteBuffer(image.getWidth() * image.getHeight() * 4);
        int[] row = new int[image.getWidth()];
        for (int y = image.getHeight() - 1; y >= 0; y--) {
            image.getRGB(0, y, image.getWidth(), 1, row, 0, image.getWidth());
            for (int argb : row) {
                pixels.put((byte) ((argb >> 16) & 0xFF));
                pixels.put((byte) ((argb >> 8) & 0xFF));
                pixels.put((byte) (argb & 0xFF));
                pixels.put((byte) ((argb >> 24) & 0xFF));
            }
        }
        pixels.flip();
        return new DecodedImage(key, image.getWidth(), image.getHeight(), pixels);
    }

    private static int upload(DecodedImage image) {
        try {
            int texture = GL11.glGenTextures();
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, texture);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MIN_FILTER, GL11.GL_LINEAR);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MAG_FILTER, GL11.GL_LINEAR);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_WRAP_S, GL12.GL_CLAMP_TO_EDGE);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_WRAP_T, GL12.GL_CLAMP_TO_EDGE);
            GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA8, image.width, image.height, 0,
                GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, image.pixels);
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, 0);
            return texture;
        } catch (Throwable error) {
            return 0;
        }
    }

    private static boolean allowed(String rawUrl) {
        try {
            URI uri = URI.create(rawUrl);
            String host = uri.getHost();
            return "https".equalsIgnoreCase(uri.getScheme()) && host != null
                && ("cdn.modrinth.com".equalsIgnoreCase(host) || "cdn-raw.modrinth.com".equalsIgnoreCase(host));
        } catch (Exception ignored) {
            return false;
        }
    }

    private void writeCache(File target, BufferedImage image) throws IOException {
        File parent = target.getParentFile();
        if (!parent.exists() && !parent.mkdirs()) throw new IOException("Could not create image cache.");
        File temporary = new File(parent, target.getName() + ".part");
        if (!ImageIO.write(image, "png", temporary)) throw new IOException("Could not encode cached image.");
        try { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (Exception ignored) { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    }

    private void cleanDiskCache() {
        try {
            File[] found = cacheDirectory.listFiles((directory, name) -> name.endsWith(".png"));
            if (found == null) return;
            List<File> files = new ArrayList<File>();
            long total = 0L;
            long now = System.currentTimeMillis();
            for (File file : found) {
                if (now - file.lastModified() > MAX_CACHE_AGE_MS) Files.deleteIfExists(file.toPath());
                else { files.add(file); total += file.length(); }
            }
            files.sort(Comparator.comparingLong(File::lastModified));
            for (File file : files) {
                if (total <= MAX_CACHE_BYTES) break;
                total -= file.length();
                Files.deleteIfExists(file.toPath());
            }
        } catch (Exception error) {
            System.out.println("[Impulse UI] Could not clean image cache: " + error.getMessage());
        }
    }

    private void scheduleCacheCleanup() {
        long now = System.currentTimeMillis();
        long previous = lastCleanup.get();
        if (now - previous < CLEAN_INTERVAL_MS || !lastCleanup.compareAndSet(previous, now)) return;
        workers.execute(this::cleanDiskCache);
    }

    private static String hash(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) result.append(String.format("%02x", item & 0xFF));
            return result.toString();
        } catch (Exception error) {
            return Integer.toHexString(value.hashCode());
        }
    }

    @Override
    public void close() {
        closed = true;
        workers.shutdownNow();
        synchronized (textures) {
            for (Texture texture : textures.values()) GL11.glDeleteTextures(texture.id);
            textures.clear();
        }
        decoded.clear();
    }

    static final class Texture {
        final int id;
        final int width;
        final int height;

        Texture(int id, int width, int height) {
            this.id = id;
            this.width = width;
            this.height = height;
        }
    }

    private static final class DecodedImage {
        final String key;
        final int width, height;
        final ByteBuffer pixels;

        DecodedImage(String key, int width, int height, ByteBuffer pixels) {
            this.key = key;
            this.width = width;
            this.height = height;
            this.pixels = pixels;
        }
    }
}

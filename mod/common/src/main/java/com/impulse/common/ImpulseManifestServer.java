package com.impulse.common;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.jar.JarFile;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;

public final class ImpulseManifestServer {
    private static HttpServer server;
    private static ExecutorService executor;
    private static final Map<String, Sha1CacheEntry> sha1Cache = new HashMap<String, Sha1CacheEntry>();
    private static final Object manifestCacheLock = new Object();
    private static ManifestCacheEntry manifestCache;

    private ImpulseManifestServer() {
    }

    public static synchronized void start(File serverRoot) {
        start(serverRoot, ImpulseRuntimeDefaults.empty());
    }

    public static synchronized void start(File serverRoot, ImpulseRuntimeDefaults runtimeDefaults) {
        start(serverRoot, runtimeDefaults, null);
    }

    public static synchronized void start(File serverRoot, ImpulseRuntimeDefaults runtimeDefaults, File selfJar) {
        if (server != null) return;
        try {
            final ImpulseConfig config = ImpulseConfig.load(serverRoot, runtimeDefaults);
            copySelfToDefaultModsDirectory(serverRoot, selfJar);
            server = HttpServer.create(new InetSocketAddress(config.manifestPort), 0);
            server.createContext("/impulse/server.json", new HttpHandler() {
                public void handle(HttpExchange exchange) throws IOException {
                    byte[] body = buildManifestCached(config).getBytes(StandardCharsets.UTF_8);
                    respond(exchange, 200, "application/json; charset=utf-8", body);
                }
            });
            server.createContext("/impulse/mods", new HttpHandler() {
                public void handle(HttpExchange exchange) throws IOException {
                    serveMod(config, exchange, config.modsDirectory, "/impulse/mods/");
                }
            });
            server.createContext("/impulse/optional-mods", new HttpHandler() {
                public void handle(HttpExchange exchange) throws IOException {
                    serveMod(config, exchange, config.optionalModsDirectory, "/impulse/optional-mods/");
                }
            });
            server.createContext("/impulse/media", new HttpHandler() {
                public void handle(HttpExchange exchange) throws IOException {
                    serveMedia(config, exchange);
                }
            });
            executor = Executors.newCachedThreadPool();
            server.setExecutor(executor);
            server.start();
            executor.submit(new Runnable() {
                public void run() {
                    try {
                        buildManifestCached(config);
                    } catch (Exception error) {
                        System.err.println("[Impulse] Failed to warm manifest cache: " + error.getMessage());
                    }
                }
            });
            Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
                public void run() {
                    stop();
                }
            }, "impulse-http-shutdown"));
            System.out.println("[Impulse] Manifest server listening on port " + config.manifestPort);
        } catch (Exception error) {
            System.err.println("[Impulse] Failed to start manifest server: " + error.getMessage());
            error.printStackTrace();
        }
    }

    private static void copySelfToDefaultModsDirectory(File serverRoot, File explicitSource) {
        try {
            File source = explicitSource != null ? explicitSource : resolveOwnJarFile();
            if (source == null) {
                System.out.println("[Impulse] Could not resolve a local server mod jar to copy into impulse/mods.");
                return;
            }
            if (!source.isFile() || !source.getName().toLowerCase().endsWith(".jar")) return;
            File targetDir = new File(serverRoot, "impulse/mods");
            if (!targetDir.exists()) targetDir.mkdirs();
            File target = new File(targetDir, "impulse.jar").getCanonicalFile();
            File canonicalSource = source.getCanonicalFile();
            if (canonicalSource.equals(target)) {
                deleteLegacyImpulseCopies(targetDir, target);
                return;
            }
            copyFile(canonicalSource, target);
            deleteLegacyImpulseCopies(targetDir, target);
            System.out.println("[Impulse] Copied server mod to " + target.getPath());
        } catch (Exception error) {
            System.err.println("[Impulse] Failed to copy server mod into impulse/mods: " + error.getMessage());
        }
    }

    private static void deleteLegacyImpulseCopies(File targetDir, File keep) {
        File[] files = targetDir.listFiles();
        if (files == null) return;
        for (int i = 0; i < files.length; i++) {
            File file = files[i];
            String name = file.getName().toLowerCase();
            if (!file.isFile() || !name.endsWith(".jar")) continue;
            if (!name.startsWith("impulse-") && !name.startsWith("impulse_")) continue;
            try {
                if (!file.getCanonicalFile().equals(keep.getCanonicalFile())) {
                    file.delete();
                }
            } catch (Exception ignored) {
            }
        }
    }

    private static File resolveOwnJarFile() {
        try {
            java.net.URL location = ImpulseManifestServer.class.getProtectionDomain().getCodeSource().getLocation();
            if (location != null && "file".equalsIgnoreCase(location.getProtocol())) {
                File file = new File(location.toURI());
                if (file.isFile()) return file;
            }
        } catch (Exception ignored) {
        }
        try {
            java.net.URL resource = ImpulseManifestServer.class.getResource("ImpulseManifestServer.class");
            if (resource != null && "jar".equalsIgnoreCase(resource.getProtocol())) {
                String external = resource.toExternalForm();
                int bang = external.indexOf('!');
                String jarUrl = bang >= 0 ? external.substring(4, bang) : "";
                java.net.URL url = new java.net.URL(jarUrl);
                if ("file".equalsIgnoreCase(url.getProtocol())) {
                    File file = new File(url.toURI());
                    if (file.isFile()) return file;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static void copyFile(File source, File target) throws IOException {
        FileInputStream input = new FileInputStream(source);
        try {
            FileOutputStream output = new FileOutputStream(target);
            try {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            } finally {
                output.close();
            }
        } finally {
            input.close();
        }
    }

    public static synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        synchronized (manifestCacheLock) {
            manifestCache = null;
        }
    }

    private static String buildManifestCached(ImpulseConfig config) throws IOException {
        String signature = manifestSignature(config);
        synchronized (manifestCacheLock) {
            if (manifestCache != null && manifestCache.signature.equals(signature)) {
                return manifestCache.json;
            }
        }

        String json = buildManifest(config);
        synchronized (manifestCacheLock) {
            manifestCache = new ManifestCacheEntry(signature, json);
        }
        return json;
    }

    private static String manifestSignature(ImpulseConfig config) throws IOException {
        StringBuilder out = new StringBuilder();
        appendDirectorySignature(out, config.modsDirectory, config, true);
        appendDirectorySignature(out, config.optionalModsDirectory, config, true);
        appendMediaSignature(out, config, config.iconFile);
        appendMediaSignature(out, config, config.bannerFile);
        appendMediaSignature(out, config, config.videoBackgroundFile);
        return out.toString();
    }

    private static void appendDirectorySignature(StringBuilder out, File directory, ImpulseConfig config, boolean applyExcludes) throws IOException {
        File[] files = directory.listFiles();
        if (files == null) {
            out.append(directory.getCanonicalPath()).append("|missing;");
            return;
        }
        Arrays.sort(files, new Comparator<File>() {
            public int compare(File left, File right) {
                return left.getName().compareToIgnoreCase(right.getName());
            }
        });
        for (File file : files) {
            String name = file.getName().toLowerCase();
            if (!file.isFile() || !name.endsWith(".jar")) continue;
            if (applyExcludes && isExcluded(config, name)) continue;
            appendFileSignature(out, file);
        }
    }

    private static void appendMediaSignature(StringBuilder out, ImpulseConfig config, String fileName) throws IOException {
        if (fileName == null) return;
        File target = new File(config.mediaDirectory, fileName).getCanonicalFile();
        File root = config.mediaDirectory.getCanonicalFile();
        if (isInside(root, target) && target.isFile()) appendFileSignature(out, target);
    }

    private static void appendFileSignature(StringBuilder out, File file) throws IOException {
        out.append(file.getCanonicalPath())
            .append('|')
            .append(file.length())
            .append('|')
            .append(file.lastModified())
            .append(';');
    }

    private static String buildManifest(ImpulseConfig config) throws IOException {
        List<ModFile> mods = scanMods(config, config.modsDirectory);
        List<ModFile> optionalMods = scanMods(config, config.optionalModsDirectory);
        Json json = new Json();
        json.object();
        json.prop("manifest_version", config.manifestVersion).comma();
        json.prop("name", config.serverName).comma();
        json.prop("description", config.description).comma();
        json.prop("icon_url", mediaUrl(config, config.iconUrl, config.iconFile)).comma();
        json.prop("banner_url", mediaUrl(config, config.bannerUrl, config.bannerFile)).comma();
        json.prop("video_background_url", mediaUrl(config, config.videoBackgroundUrl, config.videoBackgroundFile)).comma();
        json.key("server").object();
        json.prop("address", config.publicHost).comma();
        json.prop("port", config.minecraftPort).comma();
        json.prop("auto_connect", config.autoConnect);
        json.endObject().comma();
        json.key("minecraft").object();
        json.prop("version", config.minecraftVersion).comma();
        json.prop("loader", config.loader).comma();
        json.prop("loader_version", config.loaderVersion);
        json.endObject().comma();
        json.key("menu").object();
        json.prop("enabled", config.menuEnabled).comma();
        json.prop("skin", config.menuSkin).comma();
        json.prop("title", config.menuTitle).comma();
        json.prop("subtitle", config.menuSubtitle).comma();
        json.prop("hide_server_name_from_play_button", config.menuHideServerNameFromPlayButton).comma();
        json.prop("singleplayer_enabled", config.menuSingleplayerEnabled).comma();
        json.prop("multiplayer_enabled", config.menuMultiplayerEnabled);
        json.endObject().comma();
        json.key("mods").array();
        writeModsArray(json, config, mods, "/impulse/mods/", true);
        json.endArray().comma();
        json.key("optional_mods").array();
        writeModsArray(json, config, optionalMods, "/impulse/optional-mods/", false);
        json.endArray();
        json.endObject();
        return json.toString();
    }

    private static void writeModsArray(Json json, ImpulseConfig config, List<ModFile> mods, String route, boolean required) {
        for (int i = 0; i < mods.size(); i++) {
            ModFile mod = mods.get(i);
            json.object();
            json.prop("name", mod.name).comma();
            json.prop("description", mod.description).comma();
            json.prop("file_name", mod.file.getName()).comma();
            json.prop("download_url", publicUrl(config, route + urlName(mod.file.getName()))).comma();
            json.prop("sha1", mod.sha1).comma();
            json.prop("size", mod.file.length()).comma();
            json.prop("required", required);
            json.endObject();
            if (i < mods.size() - 1) json.comma();
        }
    }

    private static List<ModFile> scanMods(ImpulseConfig config, File directory) throws IOException {
        List<ModFile> out = new ArrayList<ModFile>();
        File[] files = directory.listFiles();
        if (files == null) return out;
        Arrays.sort(files, new Comparator<File>() {
            public int compare(File left, File right) {
                return left.getName().compareToIgnoreCase(right.getName());
            }
        });
        for (File file : files) {
            String name = file.getName().toLowerCase();
            if (!file.isFile() || !name.endsWith(".jar")) continue;
            if (isExcluded(config, name)) continue;
            ModMetadata metadata = readModMetadata(file);
            out.add(new ModFile(file, cachedSha1(file), metadata.name, metadata.description));
        }
        return out;
    }

    private static boolean isExcluded(ImpulseConfig config, String lowerName) {
        for (String excluded : config.excludedNames) {
            if (lowerName.contains(excluded)) return true;
        }
        return false;
    }

    private static void serveMod(ImpulseConfig config, HttpExchange exchange, File directory, String prefix) throws IOException {
        String path = exchange.getRequestURI().getRawPath();
        if (!path.startsWith(prefix)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        String name = decodePathSegment(path.substring(prefix.length()));
        if (!isSafeFileName(name)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        File target = new File(directory, name).getCanonicalFile();
        File root = directory.getCanonicalFile();
        if (!isInside(root, target) || !target.isFile() || isExcluded(config, target.getName().toLowerCase())) {
            respond(exchange, 404, "text/plain", bytes("Not found in configured mods directory: " + directory.getPath()));
            return;
        }
        serveFile(exchange, target, "application/java-archive", true);
    }

    private static void serveMedia(ImpulseConfig config, HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getRawPath();
        String prefix = "/impulse/media/";
        if (!path.startsWith(prefix)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        String name = decodePathSegment(path.substring(prefix.length()));
        if (!isSafeFileName(name)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        File target = new File(config.mediaDirectory, name).getCanonicalFile();
        File root = config.mediaDirectory.getCanonicalFile();
        if (!isInside(root, target) || !target.isFile()) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        serveFile(exchange, target, contentType(target.getName()), false);
    }

    private static void serveFile(HttpExchange exchange, File target, String contentType, boolean attachment) throws IOException {
        long total = target.length();
        long start = 0;
        long end = total > 0 ? total - 1 : 0;
        int status = 200;

        String range = exchange.getRequestHeaders().getFirst("Range");
        if (range != null && range.startsWith("bytes=") && total > 0) {
            String spec = range.substring("bytes=".length());
            int comma = spec.indexOf(',');
            if (comma >= 0) spec = spec.substring(0, comma);
            int dash = spec.indexOf('-');
            try {
                if (dash == 0) {
                    long suffix = Long.parseLong(spec.substring(1));
                    start = Math.max(0, total - suffix);
                } else if (dash > 0) {
                    start = Long.parseLong(spec.substring(0, dash));
                    if (dash < spec.length() - 1) end = Long.parseLong(spec.substring(dash + 1));
                }
                end = Math.min(end, total - 1);
                if (start <= end) status = 206;
                else {
                    Headers headers = exchange.getResponseHeaders();
                    headers.set("Content-Range", "bytes */" + total);
                    headers.set("Access-Control-Allow-Origin", "*");
                    exchange.sendResponseHeaders(416, -1);
                    exchange.close();
                    return;
                }
            } catch (Exception ignored) {
                start = 0;
                end = total - 1;
                status = 200;
            }
        }

        long responseLength = total == 0 ? 0 : end - start + 1;
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", contentType);
        headers.set("Accept-Ranges", "bytes");
        if (status == 206) headers.set("Content-Range", "bytes " + start + "-" + end + "/" + total);
        if (attachment) headers.set("Content-Disposition", "attachment; filename=\"" + target.getName().replace("\"", "") + "\"");
        headers.set("Access-Control-Allow-Origin", "*");
        exchange.sendResponseHeaders(status, responseLength);
        FileInputStream input = new FileInputStream(target);
        try {
            skipFully(input, start);
            OutputStream output = exchange.getResponseBody();
            byte[] buffer = new byte[8192];
            int read;
            long remaining = responseLength;
            while (remaining > 0 && (read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining))) >= 0) {
                output.write(buffer, 0, read);
                remaining -= read;
            }
        } finally {
            input.close();
            exchange.close();
        }
    }

    private static void respond(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException {
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", contentType);
        headers.set("Access-Control-Allow-Origin", "*");
        exchange.sendResponseHeaders(status, body.length);
        OutputStream output = exchange.getResponseBody();
        try {
            output.write(body);
        } finally {
            exchange.close();
        }
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static String sha1(File file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            FileInputStream input = new FileInputStream(file);
            try {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    digest.update(buffer, 0, read);
                }
            } finally {
                input.close();
            }
            StringBuilder out = new StringBuilder();
            for (byte b : digest.digest()) out.append(String.format("%02x", b));
            return out.toString();
        } catch (Exception error) {
            throw new IOException("Unable to hash " + file.getName(), error);
        }
    }

    private static synchronized String cachedSha1(File file) throws IOException {
        String key = file.getCanonicalPath();
        long modified = file.lastModified();
        long size = file.length();
        Sha1CacheEntry cached = sha1Cache.get(key);
        if (cached != null && cached.modified == modified && cached.size == size) {
            return cached.sha1;
        }
        String hash = sha1(file);
        sha1Cache.put(key, new Sha1CacheEntry(modified, size, hash));
        return hash;
    }

    private static ModMetadata readModMetadata(File file) {
        String fallbackName = stripJar(file.getName());
        try {
            JarFile jar = new JarFile(file);
            try {
                ModMetadata metadata = readTomlMetadata(jar, "META-INF/neoforge.mods.toml");
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
                metadata = readTomlMetadata(jar, "META-INF/mods.toml");
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
                metadata = readMcmodInfoMetadata(jar);
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
                metadata = readPackMetadata(jar);
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
            } finally {
                jar.close();
            }
        } catch (Exception ignored) {
        }
        return new ModMetadata(fallbackName, "");
    }

    private static ModMetadata readTomlMetadata(JarFile jar, String path) throws IOException {
        String text = readJarText(jar, path);
        if (text == null) return ModMetadata.empty();
        String displayName = firstTomlValue(text, "displayName");
        String description = firstTomlValue(text, "description");
        return new ModMetadata(displayName, description);
    }

    private static ModMetadata readMcmodInfoMetadata(JarFile jar) throws IOException {
        String text = readJarText(jar, "mcmod.info");
        if (text == null) return ModMetadata.empty();
        String name = firstJsonString(text, "name");
        String description = firstJsonString(text, "description");
        return new ModMetadata(name, description);
    }

    private static ModMetadata readPackMetadata(JarFile jar) throws IOException {
        String text = readJarText(jar, "pack.mcmeta");
        if (text == null) return ModMetadata.empty();
        String description = firstJsonString(text, "description");
        return new ModMetadata("", description);
    }

    private static String readJarText(JarFile jar, String path) throws IOException {
        ZipEntry entry = jar.getEntry(path);
        if (entry == null) return null;
        InputStream input = jar.getInputStream(entry);
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            input.close();
        }
    }

    private static String firstTomlValue(String text, String key) {
        Pattern pattern = Pattern.compile("(?m)^\\s*" + Pattern.quote(key) + "\\s*=\\s*(?:\"\"\"([\\s\\S]*?)\"\"\"|'([^']*)'|\"((?:\\\\.|[^\"])*)\")");
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) return "";
        String value = matcher.group(1) != null ? matcher.group(1) : (matcher.group(2) != null ? matcher.group(2) : matcher.group(3));
        return cleanMetadataValue(unescapeSimple(value));
    }

    private static String firstJsonString(String text, String key) {
        Pattern pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? cleanMetadataValue(unescapeSimple(matcher.group(1))) : "";
    }

    private static String unescapeSimple(String value) {
        if (value == null) return "";
        return value
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
    }

    private static String cleanMetadataValue(String value) {
        if (value == null) return "";
        return value.replaceAll("\\s+", " ").trim();
    }

    private static String stripJar(String name) {
        return name.toLowerCase().endsWith(".jar") ? name.substring(0, name.length() - 4) : name;
    }

    private static String mediaUrl(ImpulseConfig config, String externalUrl, String fileName) throws IOException {
        if (fileName != null) {
            File target = new File(config.mediaDirectory, fileName).getCanonicalFile();
            File root = config.mediaDirectory.getCanonicalFile();
            if (isInside(root, target) && target.isFile()) {
                return publicUrl(config, "/impulse/media/" + urlName(target.getName()));
            }
        }
        return externalUrl;
    }

    private static String publicUrl(ImpulseConfig config, String path) {
        return "http://" + config.publicHost + ":" + config.manifestPort + path;
    }

    private static boolean isInside(File root, File target) throws IOException {
        String rootPath = root.getCanonicalPath();
        String targetPath = target.getCanonicalPath();
        return targetPath.equals(rootPath) || targetPath.startsWith(rootPath + File.separator);
    }

    private static void skipFully(FileInputStream input, long bytes) throws IOException {
        long skipped = 0;
        while (skipped < bytes) {
            long step = input.skip(bytes - skipped);
            if (step <= 0) {
                if (input.read() < 0) return;
                step = 1;
            }
            skipped += step;
        }
    }

    private static String contentType(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) return "video/ogg";
        if (lower.endsWith(".mov")) return "video/quicktime";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private static String urlName(String name) {
        byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder(bytes.length);
        for (byte raw : bytes) {
            int b = raw & 255;
            if (isUnreservedPathByte(b)) {
                out.append((char) b);
            } else {
                out.append('%');
                char high = Character.toUpperCase(Character.forDigit((b >> 4) & 15, 16));
                char low = Character.toUpperCase(Character.forDigit(b & 15, 16));
                out.append(high).append(low);
            }
        }
        return out.toString();
    }

    private static boolean isUnreservedPathByte(int value) {
        return (value >= 'A' && value <= 'Z')
            || (value >= 'a' && value <= 'z')
            || (value >= '0' && value <= '9')
            || value == '-' || value == '.' || value == '_' || value == '~';
    }

    private static String decodePathSegment(String raw) throws IOException {
        byte[] bytes = new byte[raw.length() * 4];
        int length = 0;
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '%' && i + 2 < raw.length()) {
                int high = Character.digit(raw.charAt(i + 1), 16);
                int low = Character.digit(raw.charAt(i + 2), 16);
                if (high >= 0 && low >= 0) {
                    bytes[length++] = (byte) ((high << 4) + low);
                    i += 2;
                    continue;
                }
            }
            byte[] encoded = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
            for (byte b : encoded) bytes[length++] = b;
        }
        return new String(bytes, 0, length, StandardCharsets.UTF_8);
    }

    private static boolean isSafeFileName(String name) {
        return name != null
            && name.length() > 0
            && name.indexOf('/') < 0
            && name.indexOf('\\') < 0
            && name.indexOf('\0') < 0;
    }

    private static final class ModFile {
        final File file;
        final String sha1;
        final String name;
        final String description;

        ModFile(File file, String sha1, String name, String description) {
            this.file = file;
            this.sha1 = sha1;
            this.name = cleanMetadataValue(name).length() > 0 ? cleanMetadataValue(name) : stripJar(file.getName());
            this.description = cleanMetadataValue(description);
        }
    }

    private static final class ModMetadata {
        final String name;
        final String description;

        ModMetadata(String name, String description) {
            this.name = cleanMetadataValue(name);
            this.description = cleanMetadataValue(description);
        }

        static ModMetadata empty() {
            return new ModMetadata("", "");
        }

        boolean isEmpty() {
            return name.length() == 0 && description.length() == 0;
        }

        ModMetadata withFallback(String fallbackName) {
            return new ModMetadata(name.length() == 0 ? fallbackName : name, description);
        }
    }

    private static final class Sha1CacheEntry {
        final long modified;
        final long size;
        final String sha1;

        Sha1CacheEntry(long modified, long size, String sha1) {
            this.modified = modified;
            this.size = size;
            this.sha1 = sha1;
        }
    }

    private static final class ManifestCacheEntry {
        final String signature;
        final String json;

        ManifestCacheEntry(String signature, String json) {
            this.signature = signature;
            this.json = json;
        }
    }
}
